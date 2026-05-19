import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	autoContinueWorkflowIfNeeded,
	completionContinuationFingerprint,
	markQueuedDriverPromptInFlight,
	registerCookCommand,
} from "./driver";
import {
	assessMissionAnchor,
	collectRecentDiscussionEntries,
	deriveCookContextProposalFromRecentDiscussion,
	finalizeContextProposalAnalysis,
	isWeakMissionAnchor,
	missionAnchorsLikelyEquivalent,
	missionAnchorsStrictlyEquivalent,
	normalizeMissionAnchorText,
	resolveContextProposalConfirmationAction,
	shouldTreatBareActiveWorkflowProposalAsClearRefocus,
	stripCodeBlocks,
} from "./proposal";
import type {
	ContextProposal,
	ContextProposalAnalysis,
	ContextProposalConfirmAction,
	ContextProposalConfirmOptions,
	ContextProposalConfirmationLayout,
	ContextProposalDecision,
} from "./proposal";
import {
	buildContextProposalConfirmationLayout as buildExtractedContextProposalConfirmationLayout,
	buildContextProposalConfirmationSelectItems,
	buildContextProposalContinuationReason as buildExtractedContextProposalContinuationReason,
	buildEvaluationRoleContextLines as buildExtractedEvaluationRoleContextLines,
	buildEvaluationRoleReminderText as buildExtractedEvaluationRoleReminderText,
	buildNaturalLanguageHandoffMetadataLines,
	buildResumeCapsule as buildExtractedResumeCapsule,
	buildSystemReminder as buildExtractedSystemReminder,
	maybeWriteContextProposalConfirmationSnapshot,
	maybeWriteContextProposalSnapshot,
} from "./prompt-surfaces";
import { toolCallBlockReason } from "./policy-guards";
import { analyzeContextProposalWithAgent, runCompletionRole } from "./role-runner";
import {
	applyLiveRoleEvent,
	buildInlineRunningLines,
	cloneLiveRoleActivity,
	createLiveRoleActivity,
	formatElapsed,
	formatInlineRunningText,
	nowMs,
	refreshCompletionStatus,
	truncateInline,
} from "./status-surface";
import {
	asNumber,
	asString,
	asStringArray,
	completionRootKey,
	currentEvaluationProfile,
	currentTaskType,
	findCompletionRoot,
	findRepoRoot,
	isRecord,
	loadCompletionDataForReminder,
	loadCompletionSnapshot,
	pathExists,
	readText,
	scaffoldCompletionFiles as scaffoldCompletionFilesOnDisk,
} from "./state-store";
import { parseFirstNumber, parseYesNo } from "./transcription";
import type { TranscriptionResult } from "./transcription";
import type { CompletionStateSnapshot, CompletionRole, CookNaturalLanguageHandoff, JsonRecord, LiveRoleActivity } from "./types";

const PROTOCOL_ID = "completion";
const ROLE_NAMES = [
	"completion-bootstrapper",
	"completion-regrounder",
	"completion-implementer",
	"completion-reviewer",
	"completion-auditor",
	"completion-stop-judge",
] as const;
const AGENT_HOME = path.join(os.homedir(), ".pi", "agent");
const COMPLETION_STATUS_KEY = "completion";
const EXTENSION_DIR = typeof __dirname === "string" ? __dirname : process.cwd();
const PACKAGE_ROOT_CANDIDATE = path.resolve(EXTENSION_DIR, "..", "..");
const PACKAGE_ROOT = fs.existsSync(path.join(PACKAGE_ROOT_CANDIDATE, "package.json")) ? PACKAGE_ROOT_CANDIDATE : undefined;
const PACKAGE_SKILL_PATH = PACKAGE_ROOT ? path.join(PACKAGE_ROOT, "skills", "completion-protocol", "SKILL.md") : undefined;
const PACKAGE_REFERENCE_PATH = PACKAGE_ROOT
	? path.join(PACKAGE_ROOT, "skills", "completion-protocol", "references", "completion.md")
	: undefined;
const SKILL_PATH = PACKAGE_SKILL_PATH ?? path.join(AGENT_HOME, "skills", "completion-protocol", "SKILL.md");
const REFERENCE_PATH = PACKAGE_REFERENCE_PATH ?? path.join(AGENT_HOME, "skills", "completion-protocol", "references", "completion.md");
const DEFAULT_TASK_TYPE = "completion-workflow";
const DEFAULT_EVALUATION_PROFILE = "completion-rubric-v1";
const RUBRIC_EVALUATION_ROLES = ["completion-reviewer", "completion-auditor", "completion-stop-judge"] as const;

type RubricEvaluationRole = (typeof RUBRIC_EVALUATION_ROLES)[number];

const liveRoleActivityByRoot = new Map<string, LiveRoleActivity>();
const activatedCompletionRoutingRoots = new Set<string>();
const LIVE_ROLE_HEARTBEAT_MS = 5_000;

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function roleFromEnv(): string | undefined {
	return asString(process.env.PI_COMPLETION_ROLE);
}

function candidateSlices(plan: JsonRecord | undefined): JsonRecord[] {
	const slices = plan?.candidate_slices;
	return Array.isArray(slices) ? slices.filter(isRecord) : [];
}

type ExistingWorkflowDecision =
	| { action: "continue"; currentMissionAnchor: string }
	| { action: "refocus"; currentMissionAnchor: string; missionAnchor: string };

type ActiveWorkflowProposalAssessment = {
	action: "continue" | "refocus" | "unclear";
	currentMissionAnchor: string;
	proposal?: ContextProposal;
	reason: "matching_mission" | "clear_refocus" | "missing_proposal" | "ambiguous_discussion";
};

type ExistingWorkflowChooserOptions = {
	intro?: string;
	proposedMissionLabel?: string;
	refocusChoiceLabel?: string;
	comparison?: "semantic" | "strict";
};

function completionTestWorkflowActionOverride(): "continue" | "refocus" | "cancel" | undefined {
	const raw = process.env.PI_COMPLETION_EXISTING_WORKFLOW_ACTION?.trim().toLowerCase();
	return raw === "continue" || raw === "refocus" || raw === "cancel" ? raw : undefined;
}

function completionTestWorkflowMissionOverride(): string | undefined {
	return asString(process.env.PI_COMPLETION_EXISTING_WORKFLOW_MISSION);
}

function shouldSkipDriverKickoffForTests(): boolean {
	return process.env.PI_COMPLETION_SKIP_DRIVER_KICKOFF === "1";
}

function completionTestContextProposalActionOverride(): "accept" | "cancel" | undefined {
	const raw = process.env.PI_COMPLETION_CONTEXT_PROPOSAL_ACTION?.trim().toLowerCase();
	return raw === "accept" || raw === "cancel" ? raw : undefined;
}

function completionTestContextProposalUiActionOverride(): ContextProposalConfirmAction | undefined {
	const raw = process.env.PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_ACTION?.trim().toLowerCase();
	return raw === "start" || raw === "cancel" ? raw : undefined;
}

function completionTestExistingWorkflowChooserSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH);
}

function completionTestContextProposalUiSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_PATH);
}

function completionTestContextProposalSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH);
}

function completionTestActiveWorkflowRoutingSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH);
}

function completionTestDriverPromptPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_DRIVER_PROMPT_PATH);
}

function completionTestAutoContinuePromptPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_AUTO_CONTINUE_PROMPT_PATH);
}

function shouldTestAutoContinueOnSessionStart(): boolean {
	return process.env.PI_COMPLETION_TEST_AUTO_CONTINUE_ON_SESSION_START === "1";
}

function completionTestSystemReminderPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_SYSTEM_REMINDER_PATH);
}

function maybeWriteTestSnapshot(targetPath: string | undefined, content: string): void {
	if (!targetPath) return;
	try {
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.writeFileSync(targetPath, content, "utf8");
	} catch {
		// ignore malformed or unwritable test snapshot paths
	}
}

const COOK_MAIN_CHAT_RERUN_GUIDANCE = "Discuss changes in the main chat and rerun /cook.";
const COOK_BARE_ONLY_GUIDANCE =
	"/cook is the canonical workflow boundary. Discuss the concrete repo changes in the main chat, then run /cook when you want to start, continue, refocus, or begin the next workflow round.";
const COOK_STRUCTURED_DISCUSSION_FAILURE_DETAIL =
	"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Clarify the concrete repo changes in the main chat and rerun /cook.";

function buildCookCancellationMessage(prefix: string): string {
	return `${prefix}. ${COOK_MAIN_CHAT_RERUN_GUIDANCE}`;
}

function buildCookStructuredDiscussionFailureMessage(prefix?: string): string {
	return prefix ? `${prefix} ${COOK_STRUCTURED_DISCUSSION_FAILURE_DETAIL}` : COOK_STRUCTURED_DISCUSSION_FAILURE_DETAIL;
}

function shouldDisableContextProposalAnalyst(): boolean {
	return process.env.PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST === "1";
}

function completionTestContextProposalAnalystOutput(): string | undefined {
	return asString(process.env.PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT);
}

function isWorkflowDone(snapshot: CompletionStateSnapshot | undefined): boolean {
	return asString(snapshot?.state?.continuation_policy) === "done";
}

function activateCompletionRoutingForRoot(root: string | undefined): void {
	if (!root) return;
	activatedCompletionRoutingRoots.add(path.resolve(root));
}

function hasCompletionRoutingActivation(snapshot: CompletionStateSnapshot | undefined): boolean {
	if (!snapshot) return false;
	if (roleFromEnv()) return true;
	return activatedCompletionRoutingRoots.has(path.resolve(snapshot.files.root));
}

function latestUserOrCustomTurnText(ctx: { sessionManager?: any }): string | undefined {
	return collectRecentDiscussionEntries(ctx as { sessionManager: any }, { isRecord, asString, isStaleContextError }, 1)[0]?.text;
}

function isCompletionDriverPromptTurn(ctx: { sessionManager?: any }): boolean {
	const latest = latestUserOrCustomTurnText(ctx);
	if (!latest) return false;
	if (!/^\/skill:completion-protocol\b/.test(latest)) return false;
	return /(?:Start or continue the completion workflow for this repo\.|Resume the completion workflow from canonical state\.)/.test(latest);
}

function shouldInjectCompletionWorkflowContext(snapshot: CompletionStateSnapshot | undefined, ctx: { sessionManager?: any }): boolean {
	return hasCompletionRoutingActivation(snapshot) && isCompletionDriverPromptTurn(ctx);
}

function buildDoneWorkflowBoundaryReminder(snapshot: CompletionStateSnapshot): string {
	const missionAnchor = asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? "(unknown)";
	const continuationReason = asString(snapshot.state?.continuation_reason) ?? "(unknown)";
	return [
		"A previous completion workflow exists for this repo, but it is closed.",
		`Mission anchor: ${missionAnchor}`,
		`Continuation policy: ${asString(snapshot.state?.continuation_policy) ?? "unknown"}`,
		`Continuation reason: ${continuationReason}`,
		"Treat the previous completion workflow as historical context only.",
		"Do not resume, reground, refocus, reopen, or otherwise restart completion workflow from this context unless the user explicitly runs /cook.",
		"For ordinary user requests, respond normally and ignore prior completion-protocol instructions that were only relevant to the finished workflow.",
		"Only /cook may reactivate workflow routing for the next round.",
	].join(" ");
}

function maybeWriteActiveWorkflowRoutingSnapshot(assessment: ActiveWorkflowProposalAssessment): void {
	const snapshotPath = completionTestActiveWorkflowRoutingSnapshotPath();
	if (!snapshotPath) return;
	maybeWriteTestSnapshot(
		snapshotPath,
		`${JSON.stringify(
			{
				mode: "bare",
				action: assessment.action,
				reason: assessment.reason,
				currentMissionAnchor: assessment.currentMissionAnchor,
				proposedMissionAnchor: assessment.proposal?.mission ?? null,
				proposalSource: assessment.proposal?.source ?? null,
				possibleNoise: assessment.proposal?.analysis.possibleNoise ?? [],
				alternateMissions: assessment.proposal?.analysis.alternateMissions ?? [],
				suppressedCompletedTopics: assessment.proposal?.analysis.suppressedCompletedTopics ?? [],
				suppressedNegatedTopics: assessment.proposal?.analysis.suppressedNegatedTopics ?? [],
				scope: assessment.proposal?.scope ?? [],
				constraints: assessment.proposal?.constraints ?? [],
				acceptance: assessment.proposal?.acceptance ?? [],
			},
			null,
			2,
		)}\n`,
	);
}

function buildContextProposalContinuationReason(prefix: string, goalText: string, analysis: ContextProposalAnalysis): string {
	return buildExtractedContextProposalContinuationReason(prefix, goalText, analysis, {
		defaultTaskType: DEFAULT_TASK_TYPE,
		defaultEvaluationProfile: DEFAULT_EVALUATION_PROFILE,
		truncateInline,
	});
}

function buildContextProposalConfirmationLayout(
	title: string,
	proposal: ContextProposal,
): ContextProposalConfirmationLayout {
	return buildExtractedContextProposalConfirmationLayout({
		title,
		proposal,
		analysis: finalizeContextProposalAnalysis(proposal.analysis, [proposal.goalText, proposal.mission]),
		mainChatRerunGuidance: COOK_MAIN_CHAT_RERUN_GUIDANCE,
		defaultTaskType: DEFAULT_TASK_TYPE,
		defaultEvaluationProfile: DEFAULT_EVALUATION_PROFILE,
	});
}

async function promptContextProposalConfirmationAction(
	ui: any,
	layout: ContextProposalConfirmationLayout,
): Promise<ContextProposalConfirmAction | undefined> {
	const items = buildContextProposalConfirmationSelectItems(layout);
	return await ui.custom<ContextProposalConfirmAction | undefined>((tui: any, theme: any, _kb: any, done: any) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(layout.title)), 1, 0));
		container.addChild(new Text(layout.intro, 1, 0));
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("accent", theme.bold(layout.proposalHeading)), 1, 0));
		container.addChild(new Text(layout.proposalBody, 1, 0));
		if (layout.critiqueHeading && layout.critiqueBody) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("accent", theme.bold(layout.critiqueHeading)), 1, 0));
			container.addChild(new Text(layout.critiqueBody, 1, 0));
		}
		if (layout.routingHeading && layout.routingBody) {
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("accent", theme.bold(layout.routingHeading)), 1, 0));
			container.addChild(new Text(layout.routingBody, 1, 0));
		}
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("accent", theme.bold(layout.actionsHeading)), 1, 0));
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => text,
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value as ContextProposalConfirmAction);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(layout.footer, 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) {
					done(undefined);
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function deriveCookContextProposal(
	ctx: { cwd: string; hasUI: boolean; ui: any; sessionManager: any; model?: any; modelRegistry?: any },
	projectName: string,
	hintText?: string,
): Promise<ContextProposal | undefined> {
	const recentEntries = collectRecentDiscussionEntries(ctx, { isRecord, asString, isStaleContextError });
	const snapshot = await loadCompletionSnapshot(getCtxCwd(ctx));
	const workflowContextLines = snapshot
		? [
			`current mission anchor: ${asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? asString(snapshot.active?.mission_anchor) ?? "(none)"}`,
			`continuation policy: ${asString(snapshot.state?.continuation_policy) ?? "(none)"}`,
			`latest completed slice: ${asString(snapshot.state?.latest_completed_slice) ?? "(none)"}`,
			`latest verified slice: ${asString(snapshot.state?.latest_verified_slice) ?? "(none)"}`,
			`active slice goal: ${asString(snapshot.active?.goal) ?? "(none)"}`,
			`active slice why_now: ${asString(snapshot.active?.why_now) ?? "(none)"}`,
			`verification goal: ${asString(snapshot.verificationEvidence?.goal) ?? "(none)"}`,
			`verification summary: ${asString(snapshot.verificationEvidence?.summary) ?? "(none)"}`,
		]
		: [];
	if (hintText) workflowContextLines.push(`cook hint: ${hintText}`);
	return await deriveCookContextProposalFromRecentDiscussion(projectName, recentEntries, {
		asString,
		asStringArray,
		hintText,
		workflowContext: snapshot
			? {
				currentMissionAnchor:
					asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? asString(snapshot.active?.mission_anchor),
				latestCompletedSlice: asString(snapshot.state?.latest_completed_slice),
				latestVerifiedSlice: asString(snapshot.state?.latest_verified_slice),
				activeSliceGoal: asString(snapshot.active?.goal),
				activeSliceWhyNow: asString(snapshot.active?.why_now),
				verificationGoal: asString(snapshot.verificationEvidence?.goal),
				verificationSummary: asString(snapshot.verificationEvidence?.summary),
				continuationPolicy: asString(snapshot.state?.continuation_policy),
			}
			: undefined,
		analyzeContextProposal: async (entries, derivedHintText) =>
			await analyzeContextProposalWithAgent({
				ctx,
				projectName,
				recentEntries: entries,
				workflowContextLines:
					derivedHintText && !workflowContextLines.includes(`cook hint: ${derivedHintText}`)
						? [...workflowContextLines, `cook hint: ${derivedHintText}`]
						: workflowContextLines,
				liveRoleActivityByRoot,
				completionStatusKey: COMPLETION_STATUS_KEY,
				safeUiCall,
				getCtxCwd,
				getCtxHasUI,
				getCtxUi,
			}),
		assessMissionAnchor,
		isWeakMissionAnchor,
		missionAnchorsStrictlyEquivalent,
		normalizeMissionAnchorText,
		stripCodeBlocks,
	});
}

async function confirmContextProposal(
	ctx: { hasUI: boolean; ui: any },
	proposal: ContextProposal,
	options: ContextProposalConfirmOptions,
): Promise<ContextProposalDecision | undefined> {
	maybeWriteContextProposalSnapshot(proposal, completionTestContextProposalSnapshotPath());
	const actionOverride = completionTestContextProposalActionOverride();
	if (actionOverride === "cancel") return undefined;
	if (actionOverride === "accept") {
		return resolveContextProposalConfirmationAction(proposal, "start");
	}
	const layout = buildContextProposalConfirmationLayout(options.title, proposal);
	maybeWriteContextProposalConfirmationSnapshot(layout, completionTestContextProposalUiSnapshotPath());
	const uiActionOverride = completionTestContextProposalUiActionOverride();
	if (uiActionOverride) {
		return resolveContextProposalConfirmationAction(proposal, uiActionOverride);
	}
	if (!getCtxHasUI(ctx)) {
		return options.nonInteractiveBehavior === "accept" ? resolveContextProposalConfirmationAction(proposal, "start") : undefined;
	}
	const ui = getCtxUi(ctx);
	if (!ui) {
		return options.nonInteractiveBehavior === "accept" ? resolveContextProposalConfirmationAction(proposal, "start") : undefined;
	}
	const choice = await promptContextProposalConfirmationAction(ui, layout);
	if (!choice) return undefined;
	return resolveContextProposalConfirmationAction(proposal, choice);
}



async function scaffoldCompletionFiles(
	root: string,
	missionAnchor: string,
	options?: { analysis?: ContextProposalAnalysis; continuationReason?: string },
) {
	const routing = finalizeContextProposalAnalysis(options?.analysis, [missionAnchor]);
	return await scaffoldCompletionFilesOnDisk(root, missionAnchor, {
		analysis: { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile },
		continuationReason: options?.continuationReason,
	});
}

function remainingSliceCount(plan: JsonRecord | undefined): number {
	return candidateSlices(plan).filter((slice) => {
		const status = asString(slice.status);
		return status !== "done" && status !== "cancelled";
	}).length;
}

function historyCounts(sliceHistory: JsonRecord[], stopHistory: JsonRecord[]) {
	return {
		reviewed: sliceHistory.filter((item) => asString(item.type) === "reviewed").length,
		audited: sliceHistory.filter((item) => asString(item.type) === "audited").length,
		accepted: sliceHistory.filter((item) => asString(item.type) === "accepted").length,
		reopened: sliceHistory.filter((item) => asString(item.type) === "reopened").length,
		judgments: stopHistory.filter((item) => asString(item.type) === "judgment").length,
	};
}

function sameStringArrays(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function hasOwnField(record: JsonRecord | undefined, field: string): boolean {
	return !!record && Object.prototype.hasOwnProperty.call(record, field);
}

function activeCarriesExactHandoff(active: JsonRecord | undefined): boolean {
	const status = asString(active?.status);
	return status === "selected" || status === "in_progress" || status === "committed" || status === "done";
}

function activeSliceContractDriftFields(snapshot: CompletionStateSnapshot): string[] | undefined {
	const active = snapshot.active;
	const planSlice = snapshot.activeSlice;
	const activeId = asString(active?.slice_id);
	if (!activeId || !planSlice) return undefined;
	const drift: string[] = [];
	const expectPlanArrayMirror = (field: string) => {
		if (!hasOwnField(planSlice, field) || !sameStringArrays(asStringArray(planSlice[field]), asStringArray(active?.[field]))) {
			drift.push(field);
		}
	};
	const expectPlanStringMirror = (field: string) => {
		if (!hasOwnField(planSlice, field) || asString(planSlice[field]) !== asString(active?.[field])) {
			drift.push(field);
		}
	};
	const expectPlanNumberMirror = (field: string) => {
		if (!hasOwnField(planSlice, field) || asNumber(planSlice[field]) !== asNumber(active?.[field])) {
			drift.push(field);
		}
	};
	if (asString(planSlice.slice_id) !== activeId) drift.push("slice_id");
	if (asString(planSlice.goal) !== asString(active?.goal)) drift.push("goal");
	if (!sameStringArrays(asStringArray(planSlice.contract_ids), asStringArray(active?.contract_ids))) drift.push("contract_ids");
	if (!sameStringArrays(asStringArray(planSlice.acceptance_criteria), asStringArray(active?.acceptance_criteria))) drift.push("acceptance_criteria");
	if (!sameStringArrays(asStringArray(planSlice.blocked_on), asStringArray(active?.blocked_on))) drift.push("blocked_on");
	if (asNumber(planSlice.priority) !== asNumber(active?.priority)) drift.push("priority");
	if (asString(planSlice.why_now) !== asString(active?.why_now)) drift.push("why_now");
	expectPlanArrayMirror("implementation_surfaces");
	expectPlanArrayMirror("verification_commands");
	expectPlanArrayMirror("locked_notes");
	expectPlanArrayMirror("must_fix_findings");
	expectPlanStringMirror("basis_commit");
	expectPlanArrayMirror("remaining_contract_ids_before");
	expectPlanNumberMirror("release_blocker_count_before");
	expectPlanNumberMirror("high_value_gap_count_before");
	return Array.from(new Set(drift));
}

function activeSliceContractDriftSummary(snapshot: CompletionStateSnapshot): string {
	const activeId = asString(snapshot.active?.slice_id);
	if (!activeId) return "unknown";
	if (!snapshot.activeSlice) return "slice_id (no matching plan slice)";
	const drift = activeSliceContractDriftFields(snapshot);
	return drift && drift.length > 0 ? drift.join(", ") : "none";
}

function activeSliceMatchesPlan(snapshot: CompletionStateSnapshot): "yes" | "no" | "unknown" {
	const activeId = asString(snapshot.active?.slice_id);
	if (!activeId) return "unknown";
	const drift = activeSliceContractDriftFields(snapshot);
	if (!snapshot.activeSlice || drift === undefined) return "no";
	return drift.length === 0 ? "yes" : "no";
}

function handoffSnapshotState(active: JsonRecord | undefined): "present" | "missing_or_unclear" {
	const exactArrays = [
		asStringArray(active?.acceptance_criteria),
		asStringArray(active?.implementation_surfaces),
		asStringArray(active?.verification_commands),
	];
	const required = [
		active?.priority,
		active?.why_now,
		active?.blocked_on,
		active?.locked_notes,
		active?.must_fix_findings,
		active?.basis_commit,
		active?.remaining_contract_ids_before,
		active?.release_blocker_count_before,
		active?.high_value_gap_count_before,
	];
	return activeCarriesExactHandoff(active) && exactArrays.every((items) => items.length > 0) && required.every((value) => value !== undefined && value !== null)
		? "present"
		: "missing_or_unclear";
}

function hasRunningCompletionRole(rootKey: string): boolean {
	return liveRoleActivityByRoot.get(rootKey)?.status === "running";
}

function isRubricEvaluationRole(role: string | undefined): role is RubricEvaluationRole {
	return RUBRIC_EVALUATION_ROLES.includes(role as RubricEvaluationRole);
}

function activeSliceContext(snapshot: CompletionStateSnapshot) {
	const active = snapshot.active;
	const activeSlice = snapshot.activeSlice;
	return {
		sliceId: asString(active?.slice_id) ?? asString(activeSlice?.slice_id),
		status: asString(active?.status) ?? asString(activeSlice?.status),
		goal: asString(active?.goal) ?? asString(activeSlice?.goal),
		contractIds:
			asStringArray(active?.contract_ids).length > 0 ? asStringArray(active?.contract_ids) : asStringArray(activeSlice?.contract_ids),
		acceptance:
			asStringArray(active?.acceptance_criteria).length > 0
				? asStringArray(active?.acceptance_criteria)
				: asStringArray(activeSlice?.acceptance_criteria),
		implementationSurfaces: asStringArray(active?.implementation_surfaces),
		verificationCommands: asStringArray(active?.verification_commands),
		lockedNotes: asStringArray(active?.locked_notes),
		mustFixFindings: asStringArray(active?.must_fix_findings),
		remainingBefore: asStringArray(active?.remaining_contract_ids_before),
		basisCommit: asString(active?.basis_commit),
		releaseBlockerCountBefore: asNumber(active?.release_blocker_count_before),
		highValueGapCountBefore: asNumber(active?.high_value_gap_count_before),
	};
}

function verificationEvidenceContext(snapshot: CompletionStateSnapshot) {
	const evidence = snapshot.verificationEvidence;
	return {
		path: path.relative(snapshot.files.root, snapshot.files.verificationEvidencePath) || ".agent/verification-evidence.json",
		status: evidence ? "present" : "missing",
		subjectType: asString(evidence?.subject_type),
		sliceId: asString(evidence?.slice_id),
		goal: asString(evidence?.goal),
		contractIds: asStringArray(evidence?.contract_ids),
		basisCommit: asString(evidence?.basis_commit),
		headSha: asString(evidence?.head_sha),
		verificationCommands: asStringArray(evidence?.verification_commands),
		outcome: asString(evidence?.outcome),
		recordedAt: asString(evidence?.recorded_at),
		summary:
			asString(evidence?.summary) ??
			(evidence ? "Canonical verification evidence is present but its summary is missing." : "Canonical verification evidence is missing."),
	};
}

function buildEvaluationRoleContextLines(snapshot: CompletionStateSnapshot, role: RubricEvaluationRole): string[] {
	return buildExtractedEvaluationRoleContextLines(snapshot, role, {
		asString,
		currentTaskType,
		currentEvaluationProfile,
		activeSliceContext,
		verificationEvidenceContext,
	});
}

function buildEvaluationRoleReminderText(snapshot: CompletionStateSnapshot, role: RubricEvaluationRole): string {
	return buildExtractedEvaluationRoleReminderText(snapshot, role, {
		asString,
		currentTaskType,
		currentEvaluationProfile,
		activeSliceContext,
		verificationEvidenceContext,
	});
}

function composeSystemReminder(snapshot: CompletionStateSnapshot, sliceHistory: JsonRecord[], stopHistory: JsonRecord[]): string {
	const history = historyCounts(sliceHistory, stopHistory);
	const implementationSurfaces = asStringArray(snapshot.active?.implementation_surfaces);
	const verificationCommands = asStringArray(snapshot.active?.verification_commands);
	const activePriority = asNumber(snapshot.active?.priority);
	const activeWhyNow = asString(snapshot.active?.why_now);
	const nextRole = asString(snapshot.state?.next_mandatory_role);
	const exactActiveContract = activeCarriesExactHandoff(snapshot.active);
	const activeContractDrift = activeSliceContractDriftSummary(snapshot);
	const evidence = verificationEvidenceContext(snapshot);
	const activePriorityLine = activePriority !== undefined ? `Active slice priority: ${activePriority}` : undefined;
	const activeWhyNowLine = activeWhyNow ? `Active slice why_now: ${activeWhyNow}` : undefined;
	const implementationSurfacesLine =
		implementationSurfaces.length > 0 ? `Active implementation surfaces: ${implementationSurfaces.join(", ")}` : undefined;
	const verificationCommandsLine =
		verificationCommands.length > 0 ? `Active verification commands: ${verificationCommands.join(" | ")}` : undefined;
	return buildExtractedSystemReminder({
		missionAnchor: asString(snapshot.state?.mission_anchor),
		taskType: currentTaskType(snapshot),
		evaluationProfile: currentEvaluationProfile(snapshot),
		currentPhase: asString(snapshot.state?.current_phase),
		continuationPolicy: asString(snapshot.state?.continuation_policy),
		continuationReason: asString(snapshot.state?.continuation_reason),
		nextMandatoryRole: nextRole,
		nextMandatoryAction: asString(snapshot.state?.next_mandatory_action),
		remainingSliceCount: remainingSliceCount(snapshot.plan),
		remainingStopJudges: asNumber(snapshot.state?.remaining_stop_judges) ?? "(unknown)",
		history,
		exactActiveContract,
		activeContractDrift,
		activePriority,
		activeWhyNow,
		implementationSurfaces,
		verificationCommands,
		activePriorityLine,
		activeWhyNowLine,
		implementationSurfacesLine,
		verificationCommandsLine,
		evidence,
		evaluationRoleReminderText: isRubricEvaluationRole(nextRole) ? buildEvaluationRoleReminderText(snapshot, nextRole) : undefined,
	});
}

function buildPostCompactionDriverInstructions(snapshot: CompletionStateSnapshot, marker: JsonRecord | undefined): string {
	const markerAt = typeof marker?.recorded_at === "number" ? new Date(marker.recorded_at).toISOString() : "(unknown time)";
	const nextRole = asString(snapshot.state?.next_mandatory_role) ?? "unknown";
	const nextAction = asString(snapshot.state?.next_mandatory_action) ?? "unknown";
	const continuation = asString(snapshot.state?.continuation_policy) ?? "unknown";
	const activeSliceId = asString(snapshot.active?.slice_id) ?? asString(snapshot.activeSlice?.slice_id) ?? "(none)";
	const taskType = currentTaskType(snapshot) ?? "(missing)";
	const evaluationProfile = currentEvaluationProfile(snapshot) ?? "(missing)";
	const implementationSurfaces = asStringArray(snapshot.active?.implementation_surfaces);
	const verificationCommands = asStringArray(snapshot.active?.verification_commands);
	const activePriority = asNumber(snapshot.active?.priority);
	const activeWhyNow = asString(snapshot.active?.why_now);
	const exactActiveContract = activeCarriesExactHandoff(snapshot.active);
	const activeContractDrift = activeSliceContractDriftSummary(snapshot);
	const evidence = verificationEvidenceContext(snapshot);
	const lines = [
		"POST-COMPACTION RECOVERY MODE is active.",
		`Compaction marker time: ${markerAt}`,
		"Treat the previous conversation as lossy continuity support only.",
		"Before taking any substantive action, re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, .agent/stop-check-history.jsonl, and .agent/verification-evidence.json from disk.",
		`Canonical task_type is currently: ${taskType}`,
		`Canonical evaluation_profile is currently: ${evaluationProfile}`,
		`Canonical next mandatory role is currently: ${nextRole}`,
		`Canonical next mandatory action is currently: ${nextAction}`,
		`Canonical continuation policy is currently: ${continuation}`,
		`Canonical active slice is currently: ${activeSliceId}`,
		`Canonical verification evidence artifact is currently: ${evidence.path} (${evidence.status})`,
		"Do not trust pre-compaction memory over canonical files.",
		"If the canonical state is ambiguous, inconsistent, missing, or stale after re-reading it, your first mandatory action is to dispatch completion-regrounder rather than guessing.",
		"If continuation_policy == continue and canonical state is coherent, continue dispatching the mandatory role directly without asking the user whether to continue.",
		"If you are about to implement after compaction, confirm the active slice snapshot still matches .agent/plan.json before doing any work.",
	];
	if (exactActiveContract) {
		lines.push("For selected/in-progress/committed/done slices, .agent/active-slice.json is the canonical implementation contract.");
		lines.push(`Canonical active-slice contract drift is currently: ${activeContractDrift}`);
	}
	if (activePriority !== undefined) lines.push(`Canonical active-slice priority is currently: ${activePriority}`);
	if (activeWhyNow) lines.push(`Canonical active-slice why_now is currently: ${activeWhyNow}`);
	if (implementationSurfaces.length > 0) lines.push(`Canonical implementation surfaces are currently: ${implementationSurfaces.join(", ")}`);
	if (verificationCommands.length > 0) lines.push(`Canonical verification commands are currently: ${verificationCommands.join(" | ")}`);
	if (evidence.subjectType) lines.push(`Canonical verification evidence subject is currently: ${evidence.subjectType}`);
	if (evidence.outcome) lines.push(`Canonical verification evidence outcome is currently: ${evidence.outcome}`);
	if (evidence.recordedAt) lines.push(`Canonical verification evidence recorded_at is currently: ${evidence.recordedAt}`);
	if (evidence.headSha) lines.push(`Canonical verification evidence head_sha is currently: ${evidence.headSha}`);
	if (evidence.basisCommit) lines.push(`Canonical verification evidence basis_commit is currently: ${evidence.basisCommit}`);
	if (evidence.verificationCommands.length > 0) {
		lines.push(`Canonical verification evidence commands are currently: ${evidence.verificationCommands.join(" | ")}`);
	}
	lines.push(`Canonical verification evidence summary is currently: ${evidence.summary}`);
	if (isRubricEvaluationRole(nextRole)) lines.push(buildEvaluationRoleReminderText(snapshot, nextRole));
	return lines.join(" ");
}

function isStaleContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("This extension ctx is stale after session replacement or reload");
}

function safeUiCall(action: () => void) {
	try {
		action();
	} catch (error) {
		if (isStaleContextError(error)) return;
		throw error;
	}
}

function getCtxCwd(ctx: { cwd: string }): string {
	try {
		return ctx.cwd;
	} catch (error) {
		if (isStaleContextError(error)) return process.cwd();
		throw error;
	}
}

function getCtxHasUI(ctx: { hasUI: boolean }): boolean {
	try {
		return ctx.hasUI;
	} catch (error) {
		if (isStaleContextError(error)) return false;
		throw error;
	}
}

function getCtxUi<T extends { ui: any }>(ctx: T): any | undefined {
	try {
		return ctx.ui;
	} catch (error) {
		if (isStaleContextError(error)) return undefined;
		throw error;
	}
}

function getSystemPromptSafe(ctx: { getSystemPrompt: () => string }): string | undefined {
	try {
		return ctx.getSystemPrompt();
	} catch (error) {
		if (isStaleContextError(error)) return undefined;
		throw error;
	}
}

function emitCommandText(ctx: { hasUI: boolean; ui: any }, text: string, level: "info" | "success" | "warning" | "error" = "info") {
	if (getCtxHasUI(ctx)) {
		const ui = getCtxUi(ctx);
		if (ui) safeUiCall(() => ui.notify(text, level));
		else console.log(text);
	} else {
		console.log(text);
	}
}

function composeResumeCapsule(snapshot: CompletionStateSnapshot, sliceHistory: JsonRecord[], stopHistory: JsonRecord[]): string {
	const history = historyCounts(sliceHistory, stopHistory);
	const acceptance = asStringArray(snapshot.active?.acceptance_criteria).length > 0
		? asStringArray(snapshot.active?.acceptance_criteria)
		: asStringArray(snapshot.activeSlice?.acceptance_criteria);
	const contractIds = asStringArray(snapshot.active?.contract_ids).length > 0
		? asStringArray(snapshot.active?.contract_ids)
		: asStringArray(snapshot.activeSlice?.contract_ids);
	const blockedOn = asStringArray(snapshot.active?.blocked_on).length > 0
		? asStringArray(snapshot.active?.blocked_on)
		: asStringArray(snapshot.activeSlice?.blocked_on);
	const lockedNotes = asStringArray(snapshot.active?.locked_notes);
	const mustFixFindings = asStringArray(snapshot.active?.must_fix_findings);
	const implementationSurfaces = asStringArray(snapshot.active?.implementation_surfaces);
	const verificationCommands = asStringArray(snapshot.active?.verification_commands);
	const remainingBefore = asStringArray(snapshot.active?.remaining_contract_ids_before);
	const evidence = verificationEvidenceContext(snapshot);
	const implementationSurfacesLine =
		implementationSurfaces.length > 0 ? `- implementation_surfaces: ${implementationSurfaces.join(" | ")}` : undefined;
	const verificationCommandsLine =
		verificationCommands.length > 0 ? `- verification_commands: ${verificationCommands.join(" | ")}` : undefined;
	return buildExtractedResumeCapsule({
		missionAnchor: asString(snapshot.state?.mission_anchor),
		taskType: currentTaskType(snapshot),
		evaluationProfile: currentEvaluationProfile(snapshot),
		currentPhase: asString(snapshot.state?.current_phase),
		continuationPolicy: asString(snapshot.state?.continuation_policy),
		continuationReason: asString(snapshot.state?.continuation_reason),
		requiresReground: asBoolean(snapshot.state?.requires_reground) ?? "unknown",
		nextMandatoryRole: asString(snapshot.state?.next_mandatory_role),
		nextMandatoryAction: asString(snapshot.state?.next_mandatory_action),
		remainingSliceCount: remainingSliceCount(snapshot.plan),
		remainingStopJudges: asNumber(snapshot.state?.remaining_stop_judges) ?? "(unknown)",
		history,
		activeSliceMatchesPlan: activeSliceMatchesPlan(snapshot),
		activeSliceContractDrift: activeSliceContractDriftSummary(snapshot),
		implementerHandoffSnapshot: handoffSnapshotState(snapshot.active),
		evidence,
		activeSlice: {
			sliceId: asString(snapshot.active?.slice_id) ?? asString(snapshot.activeSlice?.slice_id),
			status: asString(snapshot.active?.status) ?? asString(snapshot.activeSlice?.status),
			goal: asString(snapshot.active?.goal) ?? asString(snapshot.activeSlice?.goal),
			priority: asNumber(snapshot.active?.priority),
			whyNow: asString(snapshot.active?.why_now),
			contractIds,
			blockedOn,
			lockedNotes,
			mustFixFindings,
			implementationSurfaces,
			verificationCommands,
			implementationSurfacesLine,
			verificationCommandsLine,
			basisCommit: asString(snapshot.active?.basis_commit),
			remainingContractIdsBefore: remainingBefore,
			releaseBlockerCountBefore: asNumber(snapshot.active?.release_blocker_count_before),
			highValueGapCountBefore: asNumber(snapshot.active?.high_value_gap_count_before),
			acceptanceCriteria: acceptance,
		},
	});
}

async function gitHeadSha(cwd: string): Promise<string | undefined> {
	return await new Promise((resolve) => {
		const proc = spawn("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.on("close", (code) => {
			resolve(code === 0 ? asString(stdout) : undefined);
		});
		proc.on("error", () => resolve(undefined));
	});
}

function completionKickoff(
	goal: string,
	taskType: string,
	evaluationProfile: string,
	intent: "auto" | "continue" | "refocus" = "auto",
	missionAnchor?: string,
	naturalLanguageHandoff?: CookNaturalLanguageHandoff,
): string {
	const naturalLanguageHandoffBlock = buildNaturalLanguageHandoffMetadataLines(naturalLanguageHandoff).join("\n");
	const intentBlock =
		intent === "continue" && missionAnchor
			? `Existing canonical mission anchor:\n${missionAnchor}\n\nWorkflow intent:\n- Continue the existing workflow.\n- Treat the new user text as supplemental direction unless canonical reconciliation proves the mission itself must change.\n\n`
			: intent === "refocus" && missionAnchor
				? `Updated canonical mission anchor:\n${missionAnchor}\n\nWorkflow intent:\n- The user explicitly refocused the workflow before this kickoff.\n- Re-read canonical .agent/** state and continue from the refocused mission.\n\n`
				: "";
	return `/skill:completion-protocol Start or continue the completion workflow for this repo.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\nUser goal:\n${goal}\n\n${naturalLanguageHandoffBlock}${intentBlock}Driver instructions:\n- Canonical truth is in .agent/**. Re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, and .agent/verification-evidence.json before acting when they exist.\n- If tracked completion contract files are missing or onboarding is required, invoke completion_role with role completion-bootstrapper.\n- Otherwise follow the mandatory dispatch rules from completion-protocol.\n- For selected, in-progress, committed, or done slices, treat .agent/active-slice.json as the canonical implementation contract and route to completion-regrounder if it drifts from the selected plan slice or the exact handoff is unclear.\n- Consume .agent/verification-evidence.json instead of temp-only verification summaries when it is populated.\n- Use completion_role for all completion-* role work. Do not directly implement tracked product changes yourself.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
}

function completionResumePrompt(
	taskType: string,
	evaluationProfile: string,
	naturalLanguageHandoff?: CookNaturalLanguageHandoff,
): string {
	const naturalLanguageHandoffBlock = buildNaturalLanguageHandoffMetadataLines(naturalLanguageHandoff).join("\n");
	return `/skill:completion-protocol Resume the completion workflow from canonical state.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\n${naturalLanguageHandoffBlock}Resume instructions:\n- Re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, and .agent/verification-evidence.json before acting.\n- If canonical state is missing, invalid, contradictory, stale, or ambiguous, route to completion-regrounder first.\n- For selected, in-progress, committed, or done slices, treat .agent/active-slice.json as the canonical implementation contract and route to completion-regrounder if it drifts from the selected plan slice or the exact handoff is unclear.\n- Consume .agent/verification-evidence.json instead of temp-only verification summaries when it is populated.\n- Continue from next_mandatory_role and next_mandatory_action.\n- Use completion_role for all completion-* role work.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
}

export default function completionExtension(pi: ExtensionAPI) {
	const statusSurfaceArgs = {
		liveRoleActivityByRoot,
		completionStatusKey: COMPLETION_STATUS_KEY,
		safeUiCall,
		getCtxCwd,
		getCtxHasUI,
		getCtxUi,
	};
	const driverDeps = {
		bareOnlyGuidance: COOK_BARE_ONLY_GUIDANCE,
		structuredDiscussionFailureDetail: COOK_STRUCTURED_DISCUSSION_FAILURE_DETAIL,
		mainChatRerunGuidance: COOK_MAIN_CHAT_RERUN_GUIDANCE,
		cookCommandSpec: {
			description: "/cook workflow: start, continue, refocus, or start the next round from an explicit /cook command",
		},
		buildContextProposalContinuationReason,
		completionKickoff,
		completionResumePrompt,
		completionRootKey,
		completionTestAutoContinuePromptPath,
		completionTestDriverPromptPath,
		completionTestExistingWorkflowChooserSnapshotPath,
		completionTestWorkflowActionOverride,
		completionTestWorkflowMissionOverride,
		confirmContextProposal,
		deriveCookContextProposal,
		emitCommandText,
		finalizeContextProposalAnalysis,
		getCtxCwd,
		getCtxHasUI,
		getCtxUi,
		hasRunningCompletionRole,
		maybeWriteActiveWorkflowRoutingSnapshot,
		activateCompletionRoutingForRoot,
		maybeWriteTestSnapshot,
		missionAnchorsLikelyEquivalent,
		missionAnchorsStrictlyEquivalent,
		scaffoldCompletionFiles,
		shouldSkipDriverKickoffForTests,
		shouldTestAutoContinueOnSessionStart,
		shouldTreatBareActiveWorkflowProposalAsClearRefocus,
	};


	pi.on("session_start", async (_event, ctx) => {
		await refreshCompletionStatus({ ctx, ...statusSurfaceArgs });
		if (shouldTestAutoContinueOnSessionStart()) {
			const snapshot = await loadCompletionSnapshot(getCtxCwd(ctx));
			if (hasCompletionRoutingActivation(snapshot) && isCompletionDriverPromptTurn(ctx)) {
				await autoContinueWorkflowIfNeeded(pi, ctx, driverDeps);
			}
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshCompletionStatus({ ctx, ...statusSurfaceArgs });
	});

	pi.on("agent_end", async (_event, ctx) => {
		const snapshot = await loadCompletionSnapshot(getCtxCwd(ctx));
		if (snapshot && (await pathExists(snapshot.files.compactionMarkerPath))) {
			await fsp.rm(snapshot.files.compactionMarkerPath, { force: true });
		}
		await refreshCompletionStatus({ ctx, ...statusSurfaceArgs });
		if (hasCompletionRoutingActivation(snapshot) && isCompletionDriverPromptTurn(ctx)) {
			await autoContinueWorkflowIfNeeded(pi, ctx, driverDeps);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const loaded = await loadCompletionDataForReminder(getCtxCwd(ctx));
		const driverPromptTurn = isCompletionDriverPromptTurn(ctx);
		if (loaded && driverPromptTurn) {
			const rootKey = completionRootKey(loaded.snapshot, getCtxCwd(ctx));
			const fingerprint = completionContinuationFingerprint(loaded.snapshot);
			if (fingerprint) markQueuedDriverPromptInFlight(rootKey, fingerprint);
		}
		if (!loaded || !shouldInjectCompletionWorkflowContext(loaded.snapshot, ctx)) return;
		const additions = isWorkflowDone(loaded.snapshot)
			? [buildDoneWorkflowBoundaryReminder(loaded.snapshot)]
			: [composeSystemReminder(loaded.snapshot, loaded.sliceHistory, loaded.stopHistory)];
		if (!isWorkflowDone(loaded.snapshot)) {
			const markerText = await readText(loaded.snapshot.files.compactionMarkerPath);
			let marker: JsonRecord | undefined;
			if (markerText) {
				try {
					const parsed = JSON.parse(markerText);
					marker = isRecord(parsed) ? parsed : undefined;
				} catch {
					marker = undefined;
				}
			}
			if (marker) additions.push(buildPostCompactionDriverInstructions(loaded.snapshot, marker));
		}
		maybeWriteTestSnapshot(completionTestSystemReminderPath(), additions.join("\n\n"));
		const systemPrompt = getSystemPromptSafe(ctx);
		if (!systemPrompt) return;
		return {
			systemPrompt: `${systemPrompt}\n\n${additions.join("\n\n")}`,
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const loaded = await loadCompletionDataForReminder(getCtxCwd(ctx));
		if (!loaded || isWorkflowDone(loaded.snapshot)) return;
		const { preparation } = event;
		const summary = composeResumeCapsule(loaded.snapshot, loaded.sliceHistory, loaded.stopHistory);
		await fsp.mkdir(loaded.snapshot.files.tmpDir, { recursive: true });
		await fsp.writeFile(
			loaded.snapshot.files.compactionMarkerPath,
			`${JSON.stringify({
				recorded_at: Date.now(),
				mission_anchor: asString(loaded.snapshot.state?.mission_anchor) ?? null,
				next_mandatory_role: asString(loaded.snapshot.state?.next_mandatory_role) ?? null,
				next_mandatory_action: asString(loaded.snapshot.state?.next_mandatory_action) ?? null,
				continuation_policy: asString(loaded.snapshot.state?.continuation_policy) ?? null,
				active_slice_id: asString(loaded.snapshot.active?.slice_id) ?? asString(loaded.snapshot.activeSlice?.slice_id) ?? null,
			}, null, 2)}\n`,
			"utf8",
		);
		emitCommandText(ctx, "Completion continuity capsule injected for compaction", "info");
		return {
			compaction: {
				summary,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: preparation.fileOps,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const role = roleFromEnv();
		const cwd = getCtxCwd(ctx);
		const snapshot = await loadCompletionSnapshot(cwd);
		const completionActive = Boolean(snapshot) && asString(snapshot?.state?.continuation_policy) !== "done";
		const root = snapshot?.files.root ?? findRepoRoot(cwd) ?? cwd;
		const reason = toolCallBlockReason({
			toolName: event.toolName,
			input: isRecord(event.input) ? event.input : undefined,
			role,
			completionActive,
			root,
		});
		if (reason) return { block: true, reason };
	});

	pi.registerTool({
		name: "completion_role",
		label: "Completion Role",
		description: "Run one completion workflow role in an isolated pi subprocess. Only the main workflow driver should call this tool.",
		promptSnippet: "Dispatch one completion workflow role in isolated context.",
		promptGuidelines: [
			"Use completion_role when driving the completion workflow and a mandatory completion role must act next.",
			"Use completion_role only for completion-bootstrapper, completion-regrounder, completion-implementer, completion-reviewer, completion-auditor, or completion-stop-judge.",
			"Do not use completion_role from inside a completion role; only the workflow driver may dispatch roles.",
		],
		parameters: Type.Object({
			role: StringEnum(ROLE_NAMES, { description: "The completion role to invoke." }),
			task: Type.Optional(Type.String({ description: "Optional extra task context for the selected role." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const role = params.role as CompletionRole;
			const cwd = getCtxCwd(ctx);
			const runCwd = findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? cwd;
			const rootKey = runCwd;
			type RunningDetails = {
				role: string;
				status: "running" | "ok" | "error";
				currentAction?: string;
				toolActivity?: string;
				toolRecentActivity?: string[];
				recentActivity?: string[];
				assistantSummary?: string;
				lastAssistantText?: string;
				progress?: string;
				rationale?: string;
				nextStep?: string;
				verifying?: string;
				stateDeltas?: string[];
				startedAt?: number;
				updatedAt?: number;
				stderr?: string;
				reportFields?: Record<string, string>;
				transcription?: TranscriptionResult;
				exitCode?: number;
			};
			const emitActivityUpdate = (activity: LiveRoleActivity) => {
				const details: RunningDetails = {
					role,
					status: activity.status,
					currentAction: activity.currentAction,
					toolActivity: activity.toolActivity,
					toolRecentActivity: activity.toolRecentActivity,
					recentActivity: activity.recentActivity,
					assistantSummary: activity.assistantSummary,
					lastAssistantText: activity.lastAssistantText,
					progress: activity.progress,
					rationale: activity.rationale,
					nextStep: activity.nextStep,
					verifying: activity.verifying,
					stateDeltas: activity.stateDeltas,
					startedAt: activity.startedAt,
					updatedAt: activity.updatedAt,
				};
				liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(activity, { status: activity.status }));
				void refreshCompletionStatus({ ctx: ctx as { cwd: string; hasUI: boolean; ui: any }, ...statusSurfaceArgs });
				onUpdate?.({
					content: [{ type: "text", text: activity.lastAssistantText || activity.currentAction || `Running ${role}...` }],
					details,
				});
			};
			const loaded = await loadCompletionDataForReminder(runCwd);
			const result = await runCompletionRole({
				root: runCwd,
				role,
				task: params.task,
				signal,
				systemPromptPreamble: [
					`Completion role: ${role}`,
					"Before acting, read the completion protocol skill and reference:",
					`- ${SKILL_PATH}`,
					`- ${REFERENCE_PATH}`,
					"Use canonical .agent/** state as the source of truth.",
				],
				evaluationContextLines: loaded && isRubricEvaluationRole(role) ? buildEvaluationRoleContextLines(loaded.snapshot, role) : undefined,
				onUpdate: emitActivityUpdate,
				onConsoleMessage: (level, message) => emitCommandText(ctx, message, level),
				createLiveRoleActivity: (name) => createLiveRoleActivity(name),
				cloneLiveRoleActivity,
				applyLiveRoleEvent,
				nowMs,
				heartbeatMs: LIVE_ROLE_HEARTBEAT_MS,
			});

			liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(result.activity, { status: result.ok ? "ok" : "error" }));
			await refreshCompletionStatus({ ctx: ctx as { cwd: string; hasUI: boolean; ui: any }, ...statusSurfaceArgs });
			setTimeout(() => {
				const current = liveRoleActivityByRoot.get(rootKey);
				if (current && current.role === role && current.status !== "running") {
					liveRoleActivityByRoot.delete(rootKey);
				}
			}, 10_000);
			return {
				content: [{ type: "text", text: result.output }],
				details: {
					role,
					status: result.ok ? "ok" : "error",
					exitCode: result.exitCode,
					stderr: result.stderr,
					reportFields: result.reportFields,
					transcription: result.transcription,
					currentAction: result.activity.currentAction,
					toolActivity: result.activity.toolActivity,
					toolRecentActivity: result.activity.toolRecentActivity,
					recentActivity: result.activity.recentActivity,
					assistantSummary: result.activity.assistantSummary,
					lastAssistantText: result.activity.lastAssistantText,
					progress: result.activity.progress,
					rationale: result.activity.rationale,
					nextStep: result.activity.nextStep,
					verifying: result.activity.verifying,
					stateDeltas: result.activity.stateDeltas,
					startedAt: result.activity.startedAt,
					updatedAt: result.activity.updatedAt,
				},
				isError: !result.ok,
			};
		},
		renderCall(args, theme) {
			const role = args.role || "completion-role";
			const task = typeof args.task === "string" ? args.task.trim() : "";
			let text = theme.fg("toolTitle", theme.bold("completion_role ")) + theme.fg("accent", role);
			if (task) {
				text += `\n${theme.fg("muted", task)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result.details ?? {}) as {
				role?: string;
				status?: string;
				exitCode?: number;
				stderr?: string;
				reportFields?: Record<string, string>;
				transcription?: TranscriptionResult;
				currentAction?: string;
				toolActivity?: string;
				toolRecentActivity?: string[];
				recentActivity?: string[];
				assistantSummary?: string;
				lastAssistantText?: string;
				progress?: string;
				rationale?: string;
				nextStep?: string;
				verifying?: string;
				stateDeltas?: string[];
				startedAt?: number;
				updatedAt?: number;
			};
			if (isPartial) {
				const lines = buildInlineRunningLines(details);
				return new Text(formatInlineRunningText(theme, lines), 0, 0);
			}
			const role = details.role ?? "completion-role";
			const ok = details.status === "ok" && !result.isError;
			let text = `${theme.fg(ok ? "success" : "error", ok ? "done" : "error")} ${theme.fg("toolTitle", theme.bold(role))}`;
			if (details.startedAt !== undefined) text += `\n${theme.fg("muted", `elapsed: ${formatElapsed(nowMs() - details.startedAt)}`)}`;
			if (details.toolActivity) text += `\n${theme.fg("toolOutput", `tool: ${details.toolActivity}`)}`;
			if (details.progress) text += `\n${theme.fg("toolOutput", `progress: ${details.progress}`)}`;
			else if (details.assistantSummary) text += `\nassistant: ${details.assistantSummary}`;
			if (details.rationale) text += `\n${theme.fg("muted", `rationale: ${details.rationale}`)}`;
			if (details.nextStep) text += `\n${theme.fg("muted", `next: ${details.nextStep}`)}`;
			if (details.verifying) text += `\n${theme.fg("muted", `verifying: ${details.verifying}`)}`;
			if (details.stateDeltas?.length) {
				for (const delta of details.stateDeltas.slice(-4)) text += `\n${theme.fg("muted", `state-delta: ${delta}`)}`;
			}
			if (details.transcription?.appended?.length) {
				text += `\n${theme.fg("success", `transcribed: ${details.transcription.appended.join(", ")}`)}`;
			}
			if (details.transcription?.skipped?.length && expanded) {
				text += `\n${theme.fg("muted", `skipped: ${details.transcription.skipped.join(" | ")}`)}`;
			}
			if (details.transcription?.errors?.length) {
				text += `\n${theme.fg("warning", `warnings: ${details.transcription.errors.join(" | ")}`)}`;
			}
			const reportFields = details.reportFields ?? {};
			const summaryKeys = [
				"MISSION ANCHOR",
				"Remaining contract IDs",
				"Next role to invoke",
				"Reconciliation decision",
				"Can the project stop now",
				"Acceptable as-is",
				"Plan adjustment required",
			];
			for (const key of summaryKeys) {
				const value = reportFields[key];
				if (!value) continue;
				text += `\n${theme.fg("muted", `${key}: `)}${value}`;
			}
			const body = result.content.find((item) => item.type === "text");
			if (expanded && body?.type === "text") {
				text += `\n\n${body.text}`;
			} else if (!expanded && body?.type === "text") {
				const preview = body.text.split("\n").slice(0, 4).join("\n");
				text += `\n${theme.fg("muted", preview)}`;
			}
			if (details.stderr && expanded) text += `\n${theme.fg("error", details.stderr)}`;
			return new Text(text, 0, 0);
		},
	});

	registerCookCommand(pi, driverDeps);

}
