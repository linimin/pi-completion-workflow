import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildProfileRecord,
	defaultActiveSlice,
	defaultPlan,
	defaultState,
	defaultVerificationEvidence,
	detectDocsSurfaces,
	findRepoRoot,
	loadCompletionSnapshot,
	writeJsonFile,
} from "./state-store";
import type { CompletionStateSnapshot } from "./types";

type ContextProposalAnalysis = {
	taskType?: string;
	evaluationProfile?: string;
	critique: string[];
	risks: string[];
	possibleNoise: string[];
};

type ContextProposal = {
	mission: string;
	scope: string[];
	constraints: string[];
	acceptance: string[];
	analysis: ContextProposalAnalysis;
	goalText: string;
	basisPreview: string;
	source: "session" | "analyst";
};

type ContextProposalDecision = {
	missionAnchor: string;
	goalText: string;
	analysis: ContextProposalAnalysis;
};

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
	comparison?: "strict" | "semantic";
	proposedMissionLabel?: string;
	refocusChoiceLabel?: string;
};

type DriverContext = {
	cwd: string;
	hasUI: boolean;
	ui: any;
	sessionManager?: any;
	model?: any;
	modelRegistry?: any;
};

type DriverContinuationTracker = {
	fingerprint: string;
	attempts: number;
	inFlight: boolean;
	warned: boolean;
};

export type CompletionDriverDeps = {
	bareOnlyGuidance: string;
	structuredDiscussionFailureDetail: string;
	mainChatRerunGuidance: string;
	cookCommandSpec: {
		description: string;
	};
	getCtxCwd: (ctx: { cwd: string }) => string;
	getCtxHasUI: (ctx: { hasUI: boolean }) => boolean;
	getCtxUi: <T extends { ui: any }>(ctx: T) => any | undefined;
	emitCommandText: (
		ctx: { hasUI: boolean; ui: any },
		text: string,
		level?: "info" | "success" | "warning" | "error",
	) => void;
	completionRootKey: (snapshot: CompletionStateSnapshot | undefined, cwd: string) => string;
	hasRunningCompletionRole: (rootKey: string) => boolean;
	completionKickoff: (
		goal: string,
		taskType: string,
		evaluationProfile: string,
		intent?: "auto" | "continue" | "refocus",
		missionAnchor?: string,
	) => string;
	completionResumePrompt: (taskType: string, evaluationProfile: string) => string;
	deriveCookContextProposal: (ctx: DriverContext, projectName: string) => Promise<ContextProposal | undefined>;
	confirmContextProposal: (
		ctx: { hasUI: boolean; ui: any },
		proposal: ContextProposal,
		options: { title: string; nonInteractiveBehavior?: "accept" | "cancel" },
	) => Promise<ContextProposalDecision | undefined>;
	finalizeContextProposalAnalysis: (analysis: ContextProposalAnalysis | undefined, hintTexts?: string[]) => ContextProposalAnalysis;
	buildContextProposalContinuationReason: (prefix: string, goalText: string, analysis: ContextProposalAnalysis) => string;
	scaffoldCompletionFiles: (
		root: string,
		missionAnchor: string,
		options?: { analysis?: ContextProposalAnalysis; continuationReason?: string },
	) => Promise<{ root: string; created: string[] }>;
	maybeWriteActiveWorkflowRoutingSnapshot: (assessment: ActiveWorkflowProposalAssessment) => void;
	missionAnchorsLikelyEquivalent: (left: string, right: string) => boolean;
	missionAnchorsStrictlyEquivalent: (left: string, right: string) => boolean;
	shouldTreatBareActiveWorkflowProposalAsClearRefocus: (proposal: ContextProposal) => boolean;
	maybeWriteTestSnapshot: (targetPath: string | undefined, content: string) => void;
	completionTestDriverPromptPath: () => string | undefined;
	completionTestAutoContinuePromptPath: () => string | undefined;
	completionTestExistingWorkflowChooserSnapshotPath: () => string | undefined;
	completionTestWorkflowActionOverride: () => "continue" | "refocus" | "cancel" | undefined;
	shouldSkipDriverKickoffForTests: () => boolean;
	shouldTestAutoContinueOnSessionStart: () => boolean;
};

const DRIVER_AUTO_CONTINUE_MAX_ATTEMPTS = 2;
const driverContinuationByRoot = new Map<string, DriverContinuationTracker>();

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function roleFromEnv(): string | undefined {
	return asString(process.env.PI_COMPLETION_ROLE);
}

function buildCookCancellationMessage(prefix: string, deps: CompletionDriverDeps): string {
	return `${prefix}. ${deps.mainChatRerunGuidance}`;
}

function buildCookStructuredDiscussionFailureMessage(deps: CompletionDriverDeps, prefix?: string): string {
	return prefix ? `${prefix} ${deps.structuredDiscussionFailureDetail}` : deps.structuredDiscussionFailureDetail;
}

function currentMissionAnchor(snapshot: CompletionStateSnapshot): string {
	return (
		asString(snapshot.state?.mission_anchor) ??
		asString(snapshot.plan?.mission_anchor) ??
		asString(snapshot.active?.mission_anchor) ??
		path.basename(snapshot.files.root)
	);
}

function currentTaskType(snapshot: CompletionStateSnapshot): string | undefined {
	return (
		asString(snapshot.active?.task_type) ??
		asString(snapshot.state?.task_type) ??
		asString(snapshot.plan?.task_type) ??
		asString(snapshot.profile?.task_type)
	);
}

function currentEvaluationProfile(snapshot: CompletionStateSnapshot): string | undefined {
	return (
		asString(snapshot.active?.evaluation_profile) ??
		asString(snapshot.state?.evaluation_profile) ??
		asString(snapshot.plan?.evaluation_profile) ??
		asString(snapshot.profile?.evaluation_profile)
	);
}

export function completionContinuationFingerprint(snapshot: CompletionStateSnapshot): string | undefined {
	if (asString(snapshot.state?.continuation_policy) !== "continue") return undefined;
	const nextMandatoryRole = asString(snapshot.state?.next_mandatory_role);
	if (!nextMandatoryRole) return undefined;
	return JSON.stringify({
		mission_anchor: asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? null,
		task_type: currentTaskType(snapshot) ?? null,
		evaluation_profile: currentEvaluationProfile(snapshot) ?? null,
		current_phase: asString(snapshot.state?.current_phase) ?? null,
		next_mandatory_role: nextMandatoryRole,
		next_mandatory_action: asString(snapshot.state?.next_mandatory_action) ?? null,
		active_status: asString(snapshot.active?.status) ?? null,
		active_slice_id: asString(snapshot.active?.slice_id) ?? asString(snapshot.activeSlice?.slice_id) ?? null,
		latest_completed_slice: asString(snapshot.state?.latest_completed_slice) ?? null,
		latest_verified_slice: asString(snapshot.state?.latest_verified_slice) ?? null,
	});
}

function noteQueuedDriverPrompt(rootKey: string, fingerprint: string): void {
	const tracker = driverContinuationByRoot.get(rootKey);
	if (tracker && tracker.fingerprint === fingerprint) {
		tracker.attempts += 1;
		tracker.inFlight = false;
		tracker.warned = false;
		return;
	}
	driverContinuationByRoot.set(rootKey, {
		fingerprint,
		attempts: 1,
		inFlight: false,
		warned: false,
	});
}

export function markQueuedDriverPromptInFlight(rootKey: string, fingerprint: string): void {
	const tracker = driverContinuationByRoot.get(rootKey);
	if (!tracker || tracker.fingerprint !== fingerprint) return;
	tracker.inFlight = true;
}

function clearDriverContinuationTracker(rootKey: string): void {
	driverContinuationByRoot.delete(rootKey);
}

function isWorkflowDriverActive(snapshot: CompletionStateSnapshot | undefined): boolean {
	return Boolean(snapshot) && asString(snapshot?.state?.continuation_policy) === "continue";
}

function isDriverContinuationStateParked(rootKey: string, fingerprint: string): boolean {
	const tracker = driverContinuationByRoot.get(rootKey);
	if (!tracker || tracker.fingerprint !== fingerprint) return false;
	return tracker.warned;
}

function rememberParkedDriverContinuation(rootKey: string, fingerprint: string): void {
	const tracker = driverContinuationByRoot.get(rootKey);
	if (!tracker || tracker.fingerprint !== fingerprint) return;
	tracker.warned = true;
	tracker.inFlight = false;
}

async function queueCompletionDriverPrompt(
	pi: ExtensionAPI,
	ctx: { cwd: string; hasUI: boolean; ui: any },
	rootKey: string,
	fingerprint: string,
	prompt: string,
	kind: "kickoff" | "resume" | "auto-resume",
	deps: CompletionDriverDeps,
): Promise<boolean> {
	const snapshotPath = kind === "auto-resume" ? deps.completionTestAutoContinuePromptPath() : deps.completionTestDriverPromptPath();
	deps.maybeWriteTestSnapshot(snapshotPath, `${prompt}\n`);
	noteQueuedDriverPrompt(rootKey, fingerprint);
	if (deps.shouldSkipDriverKickoffForTests()) {
		deps.emitCommandText(ctx, `Skipped completion workflow ${kind} prompt (test mode)`, "info");
		return false;
	}
	pi.sendUserMessage(prompt);
	deps.emitCommandText(ctx, `Queued completion workflow ${kind}`, "info");
	return true;
}

export async function autoContinueWorkflowIfNeeded(
	pi: ExtensionAPI,
	ctx: { cwd: string; hasUI: boolean; ui: any },
	deps: CompletionDriverDeps,
): Promise<void> {
	if (roleFromEnv()) return;
	const snapshot = await loadCompletionSnapshot(deps.getCtxCwd(ctx));
	const rootKey = deps.completionRootKey(snapshot, deps.getCtxCwd(ctx));
	if (!snapshot) {
		clearDriverContinuationTracker(rootKey);
		return;
	}
	const fingerprint = completionContinuationFingerprint(snapshot);
	if (!fingerprint) {
		clearDriverContinuationTracker(rootKey);
		return;
	}
	if (!isWorkflowDriverActive(snapshot) || deps.hasRunningCompletionRole(rootKey)) return;
	const tracker = driverContinuationByRoot.get(rootKey);
	if (tracker && tracker.fingerprint === fingerprint) {
		if (tracker.inFlight) {
			tracker.inFlight = false;
			if (tracker.attempts >= DRIVER_AUTO_CONTINUE_MAX_ATTEMPTS) {
				if (!isDriverContinuationStateParked(rootKey, fingerprint)) {
					rememberParkedDriverContinuation(rootKey, fingerprint);
					deps.emitCommandText(
						ctx,
						`Completion workflow is parked before mandatory role dispatch: ${asString(snapshot.state?.next_mandatory_role) ?? "(unknown)"}. Rerun /cook to continue from canonical state.`,
						"warning",
					);
				}
				return;
			}
		} else {
			return;
		}
	}
	const resumePrompt = deps.completionResumePrompt(currentTaskType(snapshot) ?? "(missing)", currentEvaluationProfile(snapshot) ?? "(missing)");
	await queueCompletionDriverPrompt(pi, ctx, rootKey, fingerprint, resumePrompt, "auto-resume", deps);
}

async function assessActiveWorkflowProposalRouting(
	ctx: DriverContext,
	snapshot: CompletionStateSnapshot,
	deps: CompletionDriverDeps,
): Promise<ActiveWorkflowProposalAssessment> {
	const currentMission = currentMissionAnchor(snapshot);
	const projectName = path.basename(snapshot.files.root);
	const proposal = await deps.deriveCookContextProposal(ctx, projectName);
	if (!proposal) {
		const assessment: ActiveWorkflowProposalAssessment = {
			action: "unclear",
			currentMissionAnchor: currentMission,
			reason: "missing_proposal",
		};
		deps.maybeWriteActiveWorkflowRoutingSnapshot(assessment);
		return assessment;
	}
	if (deps.missionAnchorsLikelyEquivalent(currentMission, proposal.mission)) {
		const assessment: ActiveWorkflowProposalAssessment = {
			action: "continue",
			currentMissionAnchor: currentMission,
			proposal,
			reason: "matching_mission",
		};
		deps.maybeWriteActiveWorkflowRoutingSnapshot(assessment);
		return assessment;
	}
	if (deps.shouldTreatBareActiveWorkflowProposalAsClearRefocus(proposal)) {
		const assessment: ActiveWorkflowProposalAssessment = {
			action: "refocus",
			currentMissionAnchor: currentMission,
			proposal,
			reason: "clear_refocus",
		};
		deps.maybeWriteActiveWorkflowRoutingSnapshot(assessment);
		return assessment;
	}
	const assessment: ActiveWorkflowProposalAssessment = {
		action: "unclear",
		currentMissionAnchor: currentMission,
		proposal,
		reason: "ambiguous_discussion",
	};
	deps.maybeWriteActiveWorkflowRoutingSnapshot(assessment);
	return assessment;
}

async function resumeActiveWorkflowFromCanonicalState(
	pi: ExtensionAPI,
	ctx: { cwd: string; hasUI: boolean; ui: any },
	snapshot: CompletionStateSnapshot,
	deps: CompletionDriverDeps,
): Promise<void> {
	const mission = currentMissionAnchor(snapshot);
	pi.setSessionName(`completion: ${mission.slice(0, 60)}`);
	const resumePrompt = deps.completionResumePrompt(currentTaskType(snapshot) ?? "(missing)", currentEvaluationProfile(snapshot) ?? "(missing)");
	const rootKey = deps.completionRootKey(snapshot, deps.getCtxCwd(ctx));
	const fingerprint = completionContinuationFingerprint(snapshot) ?? JSON.stringify({
		kind: "resume",
		mission_anchor: mission,
		current_phase: asString(snapshot.state?.current_phase) ?? null,
		next_mandatory_role: asString(snapshot.state?.next_mandatory_role) ?? null,
	});
	const resumeKind = deps.shouldTestAutoContinueOnSessionStart() && deps.completionTestAutoContinuePromptPath() ? "auto-resume" : "resume";
	await queueCompletionDriverPrompt(pi, ctx, rootKey, fingerprint, resumePrompt, resumeKind, deps);
}

async function confirmExistingWorkflowProposal(
	ctx: { hasUI: boolean; ui: any },
	snapshot: CompletionStateSnapshot,
	proposal: ContextProposal,
	deps: CompletionDriverDeps,
	options: ExistingWorkflowChooserOptions = {},
): Promise<ExistingWorkflowDecision | undefined> {
	const currentMission = currentMissionAnchor(snapshot);
	const comparison = options.comparison ?? "semantic";
	const missionsMatch =
		comparison === "strict"
			? deps.missionAnchorsStrictlyEquivalent(currentMission, proposal.mission)
			: deps.missionAnchorsLikelyEquivalent(currentMission, proposal.mission);
	if (missionsMatch) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const title = [
		"Existing completion workflow found",
		"",
		options.intro ?? "A workflow is already in progress. Choose how /cook should proceed:",
		"",
		"Current mission",
		currentMission,
		"",
		options.proposedMissionLabel ?? "New proposed mission",
		proposal.mission,
	].join("\n");
	const continueChoice = "Continue current workflow\n\nKeep the current mission and treat the new goal as extra direction only.";
	const refocusChoice =
		options.refocusChoiceLabel ??
		"Abandon current workflow and start this new one\n\nReview the proposed replacement in a final Start/Cancel confirmation before /cook rewrites canonical workflow state.";
	const cancelChoice = `Cancel\n\nKeep the current workflow unchanged. ${deps.mainChatRerunGuidance}`;
	deps.maybeWriteTestSnapshot(
		deps.completionTestExistingWorkflowChooserSnapshotPath(),
		`${JSON.stringify({ title, choices: [continueChoice, refocusChoice, cancelChoice] }, null, 2)}\n`,
	);
	const actionOverride = deps.completionTestWorkflowActionOverride();
	if (actionOverride === "continue") {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	if (actionOverride === "refocus") {
		return { action: "refocus", currentMissionAnchor: currentMission, missionAnchor: proposal.mission };
	}
	if (actionOverride === "cancel") return undefined;
	if (!deps.getCtxHasUI(ctx)) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const ui = deps.getCtxUi(ctx);
	if (!ui) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const choice = await ui.select(title, [continueChoice, refocusChoice, cancelChoice]);
	if (!choice || choice === cancelChoice) return undefined;
	if (choice === refocusChoice) {
		return { action: "refocus", currentMissionAnchor: currentMission, missionAnchor: proposal.mission };
	}
	return { action: "continue", currentMissionAnchor: currentMission };
}

async function refocusCompletionMission(
	snapshot: CompletionStateSnapshot,
	missionAnchor: string,
	rawGoal: string,
	analysis: ContextProposalAnalysis | undefined,
	deps: CompletionDriverDeps,
): Promise<void> {
	const requiredStopJudges = asNumber(snapshot.profile?.required_stop_judges) ?? 3;
	const root = snapshot.files.root;
	const routing = deps.finalizeContextProposalAnalysis(analysis, [rawGoal, missionAnchor]);
	const docsSurfaces = asStringArray(snapshot.profile?.docs_surfaces);
	const nextProfile = buildProfileRecord({
		projectName: asString(snapshot.profile?.project_name) ?? path.basename(root),
		requiredStopJudges,
		priorityPolicyId: asString(snapshot.profile?.priority_policy_id) ?? "completion-default",
		docsSurfaces: docsSurfaces.length > 0 ? docsSurfaces : await detectDocsSurfaces(root),
		taskType: routing.taskType,
		evaluationProfile: routing.evaluationProfile,
	});
	const nextState = {
		...defaultState(missionAnchor, {
			taskType: routing.taskType,
			evaluationProfile: routing.evaluationProfile,
			continuationReason: deps.buildContextProposalContinuationReason("User refocused workflow via /cook:", rawGoal, routing),
		}),
		remaining_stop_judges: requiredStopJudges,
		next_mandatory_action: "Reconcile canonical state from current repo truth for the refocused mission",
	};
	const nextPlan = {
		...defaultPlan(missionAnchor, { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile }),
		plan_basis: "user_refocus",
	};
	const nextActive = defaultActiveSlice(missionAnchor, { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile });
	await Promise.all([
		fsp.writeFile(path.join(snapshot.files.agentDir, "mission.md"), buildMission(path.basename(root), missionAnchor), "utf8"),
		writeJsonFile(snapshot.files.profilePath, nextProfile),
		writeJsonFile(snapshot.files.statePath, nextState),
		writeJsonFile(snapshot.files.planPath, nextPlan),
		writeJsonFile(snapshot.files.activePath, nextActive),
		writeJsonFile(snapshot.files.verificationEvidencePath, defaultVerificationEvidence()),
	]);
}

function isWorkflowDone(snapshot: CompletionStateSnapshot | undefined): boolean {
	return asString(snapshot?.state?.continuation_policy) === "done";
}

function buildMission(projectName: string, missionAnchor: string): string {
	return `# Mission\n\nProject: ${projectName}\n\nMission anchor:\n${missionAnchor}\n\nThis file is a tracked human-readable statement of the repo's completion mission. Re-grounders may refine this file when repo truth becomes clearer, but it must stay truthful to shipped behavior and the active completion objective.\n`;
}

export function registerCookCommand(pi: ExtensionAPI, deps: CompletionDriverDeps): void {
	pi.registerCommand("cook", {
		description: deps.cookCommandSpec.description,
		handler: async (args, ctx) => {
			if (args.trim().length > 0) {
				deps.emitCommandText(ctx, deps.bareOnlyGuidance, "info");
				return;
			}
			let goal: string | undefined;
			const cwd = deps.getCtxCwd(ctx);
			let snapshot = await loadCompletionSnapshot(cwd);
			const workflowDone = isWorkflowDone(snapshot);
			let kickoffIntent: "auto" | "continue" | "refocus" = "auto";
			let kickoffMissionAnchor = snapshot ? currentMissionAnchor(snapshot) : undefined;
			let kickoffAnalysis: ContextProposalAnalysis | undefined;

			if (!snapshot) {
				const root = findRepoRoot(cwd) ?? cwd;
				const projectName = path.basename(root);
				const proposal = await deps.deriveCookContextProposal(ctx, projectName);
				if (!proposal) {
					deps.emitCommandText(ctx, buildCookStructuredDiscussionFailureMessage(deps), "info");
					return;
				}
				const decision = await deps.confirmContextProposal(ctx, proposal, {
					title: "Start a completion workflow from the recent discussion?",
				});
				if (!decision) {
					deps.emitCommandText(ctx, buildCookCancellationMessage("Cancelled recent-discussion workflow proposal", deps), "info");
					return;
				}
				goal = decision.goalText;
				kickoffMissionAnchor = decision.missionAnchor;
				kickoffAnalysis = decision.analysis;
				const startupRouting = deps.finalizeContextProposalAnalysis(kickoffAnalysis, [goal ?? kickoffMissionAnchor ?? projectName]);
				const created = await deps.scaffoldCompletionFiles(root, kickoffMissionAnchor ?? projectName, {
					analysis: startupRouting,
					continuationReason: deps.buildContextProposalContinuationReason(
						"User started workflow via /cook:",
						goal ?? kickoffMissionAnchor ?? projectName,
						startupRouting,
					),
				});
				deps.emitCommandText(
					ctx,
					`Initialized completion control plane in ${created.root}${created.created.length > 0 ? ` (${created.created.length} files created)` : ""}`,
					"info",
				);
				snapshot = await loadCompletionSnapshot(root);
			}
			if (!snapshot) {
				deps.emitCommandText(ctx, "Failed to load completion workflow state", "error");
				return;
			}
			if (!goal) {
				if (workflowDone) {
					const projectName = path.basename(snapshot.files.root);
					const proposal = await deps.deriveCookContextProposal(ctx, projectName);
					if (!proposal) {
						deps.emitCommandText(ctx, buildCookStructuredDiscussionFailureMessage(deps, "The previous completion workflow is already done."), "info");
						return;
					}
					const decision = await deps.confirmContextProposal(ctx, proposal, {
						title: "The previous completion workflow is done. Start the next workflow round from the recent discussion?",
					});
					if (!decision) {
						deps.emitCommandText(ctx, buildCookCancellationMessage("Cancelled next workflow round proposal", deps), "info");
						return;
					}
					goal = decision.goalText;
					kickoffIntent = "refocus";
					kickoffMissionAnchor = decision.missionAnchor;
					await refocusCompletionMission(snapshot, decision.missionAnchor, decision.goalText, decision.analysis, deps);
					snapshot = (await loadCompletionSnapshot(snapshot.files.root)) ?? snapshot;
					deps.emitCommandText(ctx, `Started a new completion workflow round from recent discussion: ${decision.missionAnchor}`, "info");
				} else {
					const assessment = await assessActiveWorkflowProposalRouting(ctx, snapshot, deps);
					if (assessment.action !== "refocus" || !assessment.proposal) {
						await resumeActiveWorkflowFromCanonicalState(pi, ctx, snapshot, deps);
						return;
					}
					const decision = await confirmExistingWorkflowProposal(ctx, snapshot, assessment.proposal, deps, {
						intro: "Recent non-command discussion suggests a different workflow. Choose how /cook should proceed:",
						proposedMissionLabel: "Proposed mission from recent discussion",
						refocusChoiceLabel:
							"Start new workflow from recent discussion\n\nReview the proposed replacement in a final Start/Cancel confirmation before /cook rewrites canonical workflow state.",
					});
					if (!decision) {
						deps.emitCommandText(ctx, buildCookCancellationMessage("Cancelled existing workflow confirmation", deps), "info");
						return;
					}
					if (decision.action === "continue") {
						await resumeActiveWorkflowFromCanonicalState(pi, ctx, snapshot, deps);
						return;
					}
					const proposalDecision = await deps.confirmContextProposal(ctx, assessment.proposal, {
						title: "Start the replacement workflow from recent discussion?",
					});
					if (!proposalDecision) {
						deps.emitCommandText(ctx, buildCookCancellationMessage("Cancelled replacement workflow proposal", deps), "info");
						return;
					}
					goal = proposalDecision.goalText;
					kickoffIntent = "refocus";
					kickoffMissionAnchor = proposalDecision.missionAnchor;
					await refocusCompletionMission(snapshot, proposalDecision.missionAnchor, proposalDecision.goalText, proposalDecision.analysis, deps);
					snapshot = (await loadCompletionSnapshot(snapshot.files.root)) ?? snapshot;
					deps.emitCommandText(ctx, `Refocused completion mission from recent discussion to: ${proposalDecision.missionAnchor}`, "info");
				}
			}
			kickoffMissionAnchor = kickoffMissionAnchor ?? currentMissionAnchor(snapshot);
			const kickoffGoal = goal ?? kickoffMissionAnchor;
			pi.setSessionName(`completion: ${kickoffMissionAnchor.slice(0, 60)}`);
			const kickoffPrompt = deps.completionKickoff(
				kickoffGoal,
				currentTaskType(snapshot) ?? "(missing)",
				currentEvaluationProfile(snapshot) ?? "(missing)",
				kickoffIntent,
				kickoffMissionAnchor,
			);
			const rootKey = deps.completionRootKey(snapshot, deps.getCtxCwd(ctx));
			const fingerprint = completionContinuationFingerprint(snapshot) ?? JSON.stringify({
				kind: "kickoff",
				mission_anchor: kickoffMissionAnchor,
				goal: kickoffGoal,
				intent: kickoffIntent,
				task_type: currentTaskType(snapshot) ?? "(missing)",
				evaluation_profile: currentEvaluationProfile(snapshot) ?? "(missing)",
			});
			await queueCompletionDriverPrompt(pi, ctx, rootKey, fingerprint, kickoffPrompt, "kickoff", deps);
		},
	});
}
