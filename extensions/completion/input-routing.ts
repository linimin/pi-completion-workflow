import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runCookEntry, type CompletionDriverDeps } from "./driver";
import {
	buildCookTriggerAssistConfirmationLayout,
	buildCookTriggerClarificationLayout,
	buildCookTriggerRecoveryLayout,
	maybeWriteCookTriggerClarificationSnapshot,
	maybeWriteCookTriggerConfirmationSnapshot,
	maybeWriteCookTriggerRecoverySnapshot,
	maybeWriteCookTriggerRoutingSnapshot,
} from "./prompt-surfaces";
import {
	collectRecentDiscussionEntries,
	hasRecentDiscussionImplementationIntent,
	hasStructuredContextProposalSignal,
	stripCodeBlocks,
} from "./proposal";
import {
	classifyCookTriggerIntentWithAgent,
	type CookTriggerClassifierResult,
} from "./role-runner";
import { asString, loadCompletionSnapshot } from "./state-store";
import type {
	CompletionStateSnapshot,
	CookNaturalLanguageHandoff,
	CookTriggerAdoptedArtifact,
	CookTriggerClarificationAction,
	CookTriggerClarificationCapsule,
	CookTriggerClassification,
	CookTriggerConfirmationAction,
	CookTriggerDecision,
	CookTriggerRecoveryAction,
	CookTriggerWorkflowBias,
	NaturalLanguageCookTriggerMode,
} from "./types";

type InputRoutingEvent = {
	text: string;
	images?: unknown[];
	source?: string;
};

type InputRoutingContext = {
	cwd: string;
	hasUI: boolean;
	ui: any;
	sessionManager: any;
	model?: any;
	modelRegistry?: any;
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
};

type ContextProposal = Awaited<ReturnType<CompletionDriverDeps["deriveCookContextProposal"]>>;

type RecentSessionMessage = {
	role: "user" | "assistant" | "custom";
	text: string;
};

const MAX_TRIGGER_CANDIDATE_LENGTH = 120;
const MAX_TRIGGER_CANDIDATE_LINES = 3;
const ADOPTED_ARTIFACT_PREVIEW_LIMIT = 280;
const ROUTER_BYPASS_REPLAY_PREFIX = "__pi_completion_router_bypass__:";
const ROUTER_FAILURE_RETRY_LIMIT = 2;
const CLEAR_TRIGGER_PATTERNS = [
	/^(?:go ahead|please go ahead|proceed|let'?s do it|let'?s start|start(?: implementing| implementation| the workflow| the next round)?|begin(?: implementing| implementation| the workflow| the next round)?|continue(?: with implementation| implementing| the workflow)?|resume(?: the workflow| where we left off)?|next step|work on it|do it|ship it|let'?s do this instead|switch to this)\b/i,
	/^(?:開始(?:做|實作|实现|落地|下一輪)|开始(?:做|实作|实现|落地|下一轮)|那就做吧|照(?:剛剛|刚刚|這個|这个|上述|上面的)?(?:討論|讨论|方向).*(?:做|實作|实现|落地)|可以開始(?:做|實作|实现|下一輪)?|可以开始(?:做|实作|实现|下一轮)?|繼續(?:做|實作|实现|往下做)|继续(?:做|实作|实现|往下做)|接著(?:做|實作|实现)|接着(?:做|实作|实现)|下一步|那改做(?:這個|这个)|先做新的那個方向|先做新的那个方向|好，開始做這個|好，开始做这个)/u,
];
const ADOPTED_PLAN_TRIGGER_PATTERNS = [
	/^(?:use|follow|start from|begin from|work from|go with|implement from)\b.*\b(?:plan|proposal|spec|summary|notes|[\w./-]+\.md)\b/i,
	/^(?:start|begin|implement|do)\b.*\b(?:from|using)\b.*\b(?:plan|proposal|spec|summary|[\w./-]+\.md)\b/i,
	/^(?:照|依|按照|就照|跟著|跟着|用).*(?:剛剛|刚刚|最新|上面|上述|那份|這份|这份|這個|这个|方案|計劃|计划|提案|規格|规格|總結|总结|[\w./-]+\.md).*(?:做|開始|开始|實作|实现|落地)/u,
];
const EXPLICIT_ARTIFACT_ADOPTION_PATTERNS = [
	/(?:\b(?:use|follow|start from|begin from|work from|go with|implement from)\b.*\b(?:plan|proposal|spec|summary|notes|[\w./-]+\.md)\b)/i,
	/(?:照|依|按照|就照|跟著|跟着|用).*(?:剛剛|刚刚|最新|上面|上述|那份|這份|这份|這個|这个|方案|計劃|计划|提案|規格|规格|總結|总结|[\w./-]+\.md)/u,
];
const AMBIGUOUS_ACK_PATTERNS = [/^(?:ok|okay|sure|fine|yes|yeah|yep)$/i, /^(?:好|好的|可以|嗯|那就這樣|那就这样|就這樣|就这样|先這樣|先这样|收到)$/u];
const MARKDOWN_PATH_PATTERN = /(?:^|[\s("'`])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md)(?=$|[\s)"'`.,;:])/g;

function roleFromEnv(): string | undefined {
	return asString(process.env.PI_COMPLETION_ROLE);
}

function configuredTriggerMode(): NaturalLanguageCookTriggerMode {
	const raw =
		asString(process.env.PI_COMPLETION_TEST_TRIGGER_MODE)?.toLowerCase() ??
		asString(process.env.PI_COMPLETION_TRIGGER_MODE)?.toLowerCase() ??
		"assist";
	return raw === "off" || raw === "assist" || raw === "router" || raw === "auto" ? raw : "assist";
}

function effectiveTriggerMode(mode: NaturalLanguageCookTriggerMode): "off" | "assist" | "router" {
	if (mode === "off") return "off";
	if (mode === "assist") return "assist";
	return "router";
}

function triggerRoutingSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH);
}

function triggerConfirmationSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH);
}

function triggerClarificationSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_PATH);
}

function triggerRecoverySnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_RECOVERY_PATH);
}

function triggerConfirmationOverride(): CookTriggerConfirmationAction | undefined {
	const raw = asString(process.env.PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION)?.toLowerCase();
	if (!raw) return undefined;
	if (raw === "start" || raw === "start_cook" || raw === "start_workflow" || raw === "cook") return "start_workflow";
	if (raw === "send_as_normal_chat" || raw === "send-as-normal-chat" || raw === "normal_chat" || raw === "normal-chat") return "send_as_normal_chat";
	if (raw === "cancel" || raw === "dismiss") return "cancel";
	return undefined;
}

function triggerClarificationOverride(): CookTriggerClarificationAction | undefined {
	const raw = asString(process.env.PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_ACTION)?.toLowerCase();
	if (!raw) return undefined;
	if (raw === "startup" || raw === "route_startup") return "route_startup";
	if (raw === "resume" || raw === "route_resume") return "route_resume";
	if (raw === "refocus" || raw === "route_refocus") return "route_refocus";
	if (raw === "next_round" || raw === "next-round" || raw === "route_next_round") return "route_next_round";
	if (raw === "send_as_normal_chat" || raw === "send-as-normal-chat" || raw === "normal_chat" || raw === "normal-chat") return "send_as_normal_chat";
	if (raw === "cancel" || raw === "dismiss") return "cancel";
	return undefined;
}

function triggerRecoveryOverride(): CookTriggerRecoveryAction | undefined {
	const raw = asString(process.env.PI_COMPLETION_TEST_TRIGGER_RECOVERY_ACTION)?.toLowerCase();
	if (!raw) return undefined;
	if (raw === "retry" || raw === "retry_routing" || raw === "retry-routing") return "retry_routing";
	if (raw === "send_as_normal_chat" || raw === "send-as-normal-chat" || raw === "normal_chat" || raw === "normal-chat") return "send_as_normal_chat";
	if (raw === "cancel" || raw === "dismiss") return "cancel";
	return undefined;
}

function normalizeTriggerText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateInline(text: string, maxLength = ADOPTED_ARTIFACT_PREVIEW_LIMIT): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : normalized;
}

function hasImages(event: InputRoutingEvent): boolean {
	return Array.isArray(event.images) && event.images.length > 0;
}

function activeWorkflowContext(snapshot: CompletionStateSnapshot | undefined): boolean {
	return Boolean(snapshot) && asString(snapshot?.state?.continuation_policy) !== "done";
}

function isExplicitArtifactAdoption(text: string): boolean {
	return EXPLICIT_ARTIFACT_ADOPTION_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeTriggerCandidate(text: string): boolean {
	const normalized = normalizeTriggerText(text);
	if (!normalized) return false;
	if (normalized.length > MAX_TRIGGER_CANDIDATE_LENGTH) return false;
	if (text.split(/\r?\n/).length > MAX_TRIGGER_CANDIDATE_LINES) return false;
	if (normalized.startsWith("/") || normalized.startsWith("!")) return false;
	if (AMBIGUOUS_ACK_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	return CLEAR_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized)) || ADOPTED_PLAN_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasRecentImplementationContext(entries: Array<{ text: string }>): boolean {
	return entries.some((entry) => hasRecentDiscussionImplementationIntent(entry.text, stripCodeBlocks));
}

function buildTriggerWorkflowContextLines(snapshot: CompletionStateSnapshot | undefined): string[] {
	if (!snapshot) return [];
	return [
		`mission anchor: ${asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? "(none)"}`,
		`continuation policy: ${asString(snapshot.state?.continuation_policy) ?? "(none)"}`,
		`current phase: ${asString(snapshot.state?.current_phase) ?? "(none)"}`,
		`next mandatory role: ${asString(snapshot.state?.next_mandatory_role) ?? "(none)"}`,
		`active slice id: ${asString(snapshot.active?.slice_id) ?? "(none)"}`,
		`active slice goal: ${asString(snapshot.active?.goal) ?? "(none)"}`,
		`active slice why_now: ${asString(snapshot.active?.why_now) ?? "(none)"}`,
		`latest completed slice: ${asString(snapshot.state?.latest_completed_slice) ?? "(none)"}`,
		`latest verified slice: ${asString(snapshot.state?.latest_verified_slice) ?? "(none)"}`,
	];
}

function writeRoutingDecision(event: InputRoutingEvent, decision: CookTriggerDecision, extras?: Record<string, unknown>): void {
	maybeWriteCookTriggerRoutingSnapshot(
		{
			text: event.text,
			source: event.source ?? null,
			configuredMode: decision.mode,
			action: decision.action,
			reason: decision.reason,
			bypassReason: decision.bypassReason ?? null,
			classificationDecision: decision.classification?.decision ?? null,
			workflowBias: decision.classification?.workflowBias ?? null,
			confidence: decision.classification?.confidence ?? null,
			classifierReason: decision.classification?.reason ?? null,
			focusHint: decision.classification?.focusHint ?? null,
			evidence: decision.classification?.evidence ?? [],
			riskFlags: decision.classification?.riskFlags ?? [],
			...extras,
		},
		triggerRoutingSnapshotPath(),
	);
}

function classifierFailureReason(result: CookTriggerClassifierResult): string {
	switch (result.status) {
		case "timeout":
			return "classifier_timeout";
		case "invalid_output":
			return "classifier_invalid_output";
		case "error":
		default:
			return "classifier_error";
	}
}

function classifierFailureLabel(result: CookTriggerClassifierResult): string {
	switch (result.status) {
		case "timeout":
			return "The router classifier timed out before it could decide whether /cook should take over.";
		case "invalid_output":
			return "The router classifier returned invalid JSON output, so the router refused to guess.";
		case "error":
		default:
			return result.errorMessage?.trim() || "The router classifier failed before it could return a valid decision.";
	}
}

function routerBypassReplayText(text: string): string {
	return `${ROUTER_BYPASS_REPLAY_PREFIX}${text}`;
}

function consumeRouterBypassReplay(event: InputRoutingEvent): string | undefined {
	if (event.source !== "extension") return undefined;
	if (typeof event.text !== "string" || !event.text.startsWith(ROUTER_BYPASS_REPLAY_PREFIX)) return undefined;
	return event.text.slice(ROUTER_BYPASS_REPLAY_PREFIX.length);
}

async function replayOriginalMessageToPrimaryAgent(
	pi: ExtensionAPI,
	event: InputRoutingEvent,
): Promise<void> {
	await pi.sendUserMessage(routerBypassReplayText(event.text));
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) return "";
			return item.type === "text" && typeof item.text === "string" ? item.text.trim() : "";
		})
		.filter((item) => item.length > 0)
		.join("\n")
		.trim();
}

function recentSessionMessages(ctx: InputRoutingContext, limit = 12): RecentSessionMessage[] {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const entries: RecentSessionMessage[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null || Array.isArray(entry.message)) continue;
		const role = asString(entry.message.role);
		if (role !== "user" && role !== "assistant" && role !== "custom") continue;
		const text = extractMessageText(entry.message.content);
		if (!text || /^\/(?:cook|complete)\b/i.test(text)) continue;
		entries.push({ role, text });
		if (entries.length >= limit) break;
	}
	return entries;
}

function extractMarkdownPath(text: string): string | undefined {
	let match: RegExpExecArray | null;
	while ((match = MARKDOWN_PATH_PATTERN.exec(text)) !== null) {
		const candidate = match[1]?.trim();
		if (candidate) return candidate;
	}
	return undefined;
}

async function readRepoMarkdownArtifact(root: string, candidatePath: string): Promise<CookTriggerAdoptedArtifact | undefined> {
	const resolved = path.resolve(root, candidatePath);
	const relative = path.relative(root, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	try {
		const raw = await fsp.readFile(resolved, "utf8");
		return {
			kind: "repo_markdown",
			basis: "explicit_user_adoption",
			title: candidatePath,
			path: candidatePath,
			preview: truncateInline(raw),
		};
	} catch {
		return undefined;
	}
}

function findRecentPlanArtifact(recentMessages: RecentSessionMessage[]): CookTriggerAdoptedArtifact | undefined {
	for (const entry of recentMessages) {
		if (entry.role !== "assistant" && entry.role !== "custom") continue;
		if (!hasStructuredContextProposalSignal(entry.text, stripCodeBlocks) && !/(?:plan|proposal|spec|方案|計劃|计划|提案|規格|规格)/iu.test(entry.text)) {
			continue;
		}
		return {
			kind: "recent_plan",
			basis: "explicit_user_adoption",
			title: entry.role === "assistant" ? "latest discussed assistant plan" : "latest discussed plan",
			preview: truncateInline(entry.text),
		};
	}
	return undefined;
}

async function detectExplicitAdoptedArtifact(
	eventText: string,
	ctx: InputRoutingContext,
	root: string,
	recentMessages: RecentSessionMessage[],
): Promise<CookTriggerAdoptedArtifact | undefined> {
	if (!isExplicitArtifactAdoption(eventText)) return undefined;
	const markdownPath = extractMarkdownPath(eventText);
	if (markdownPath) {
		return readRepoMarkdownArtifact(root, markdownPath);
	}
	return findRecentPlanArtifact(recentMessages);
}

function buildAdoptedArtifactHint(adoptedArtifact: CookTriggerAdoptedArtifact | undefined): string | undefined {
	if (!adoptedArtifact) return undefined;
	const lines = [`User explicitly adopted ${adoptedArtifact.kind === "repo_markdown" ? "repo markdown artifact" : "recent plan"}: ${adoptedArtifact.title}`];
	if (adoptedArtifact.path) lines.push(`Artifact path: ${adoptedArtifact.path}`);
	if (adoptedArtifact.preview) lines.push(`Artifact preview: ${adoptedArtifact.preview}`);
	return lines.join("\n");
}

function buildClarificationWorkflowBiases(
	snapshot: CompletionStateSnapshot | undefined,
	proposal: ContextProposal,
): CookTriggerWorkflowBias[] {
	if (!snapshot) return ["startup"];
	if (!activeWorkflowContext(snapshot)) return ["next_round"];
	const currentMission = asString(snapshot.state?.mission_anchor) ?? asString(snapshot.plan?.mission_anchor) ?? asString(snapshot.active?.mission_anchor);
	if (proposal?.mission && currentMission && proposal.mission.trim() === currentMission.trim()) {
		return ["resume"];
	}
	if (proposal?.mission && currentMission && proposal.mission.trim() !== currentMission.trim()) {
		return ["resume", "refocus"];
	}
	return ["resume"];
}

function clarificationBiasFromAction(action: CookTriggerClarificationAction): CookTriggerWorkflowBias | undefined {
	switch (action) {
		case "route_startup":
			return "startup";
		case "route_resume":
			return "resume";
		case "route_refocus":
			return "refocus";
		case "route_next_round":
			return "next_round";
		default:
			return undefined;
	}
}

function buildClarificationCapsule(
	action: CookTriggerClarificationAction,
	classification: CookTriggerClassification,
	proposal: ContextProposal,
): CookTriggerClarificationCapsule | undefined {
	const selectedWorkflowBias = clarificationBiasFromAction(action);
	if (!selectedWorkflowBias) return undefined;
	return {
		selectedWorkflowBias,
		reason: classification.reason,
		goal: proposal?.mission ?? classification.focusHint,
		scope: proposal?.scope?.slice(0, 3),
		nonGoal: proposal?.constraints?.slice(0, 2),
		doneWhen: proposal?.acceptance?.slice(0, 2),
	};
}

function routingExtrasForArtifact(adoptedArtifact: CookTriggerAdoptedArtifact | undefined): Record<string, unknown> {
	return adoptedArtifact
		? {
			adoptedArtifactKind: adoptedArtifact.kind,
			adoptedArtifactBasis: adoptedArtifact.basis,
			adoptedArtifactTitle: adoptedArtifact.title,
			adoptedArtifactPath: adoptedArtifact.path ?? null,
			adoptedArtifactPreview: adoptedArtifact.preview ?? null,
		}
		: {
			adoptedArtifactKind: null,
			adoptedArtifactBasis: null,
			adoptedArtifactTitle: null,
			adoptedArtifactPath: null,
			adoptedArtifactPreview: null,
		};
}

function routingExtrasForClarification(clarificationCapsule: CookNaturalLanguageHandoff["clarificationCapsule"] | undefined): Record<string, unknown> {
	return clarificationCapsule
		? {
			clarificationSelectedBias: clarificationCapsule.selectedWorkflowBias,
			clarificationReason: clarificationCapsule.reason,
			clarificationGoal: clarificationCapsule.goal ?? null,
			clarificationScope: clarificationCapsule.scope ?? [],
			clarificationNonGoal: clarificationCapsule.nonGoal ?? [],
			clarificationDoneWhen: clarificationCapsule.doneWhen ?? [],
		}
		: {
			clarificationSelectedBias: null,
			clarificationReason: null,
			clarificationGoal: null,
			clarificationScope: [],
			clarificationNonGoal: [],
			clarificationDoneWhen: [],
		};
}

async function promptCookTriggerTakeover(
	ctx: InputRoutingContext,
	classification: CookTriggerClassification,
	deps: CompletionDriverDeps,
): Promise<CookTriggerConfirmationAction> {
	const override = triggerConfirmationOverride();
	const layout = buildCookTriggerAssistConfirmationLayout({
		classification,
		mainChatRerunGuidance: deps.mainChatRerunGuidance,
	});
	maybeWriteCookTriggerConfirmationSnapshot(layout, triggerConfirmationSnapshotPath());
	if (override) return override;
	if (!ctx.hasUI || !ctx.ui) return "cancel";
	const choices = layout.actions.map((action) => `${action.label}\n\n${action.description}`);
	const titleParts = [layout.title, "", layout.intro];
	if (layout.evidenceHeading && layout.evidenceBody) titleParts.push("", layout.evidenceHeading, layout.evidenceBody);
	if (layout.riskHeading && layout.riskBody) titleParts.push("", layout.riskHeading, layout.riskBody);
	if (layout.focusHintHeading && layout.focusHintBody) titleParts.push("", layout.focusHintHeading, layout.focusHintBody);
	const choice = await ctx.ui.select(titleParts.join("\n"), choices);
	if (!choice) return "cancel";
	const index = choices.indexOf(choice);
	return index >= 0 ? layout.actions[index].id : "cancel";
}

async function promptCookTriggerClarification(
	ctx: InputRoutingContext,
	snapshot: CompletionStateSnapshot | undefined,
	proposal: ContextProposal,
	adoptedArtifact: CookTriggerAdoptedArtifact | undefined,
	deps: CompletionDriverDeps,
): Promise<CookTriggerClarificationAction> {
	const workflowBiases = buildClarificationWorkflowBiases(snapshot, proposal);
	const override = triggerClarificationOverride();
	const layout = buildCookTriggerClarificationLayout({
		currentMission: asString(snapshot?.state?.mission_anchor) ?? asString(snapshot?.plan?.mission_anchor),
		candidateMission: proposal?.mission,
		workflowBiases,
		mainChatRerunGuidance: deps.mainChatRerunGuidance,
		adoptedArtifact,
	});
	maybeWriteCookTriggerClarificationSnapshot(layout, triggerClarificationSnapshotPath());
	if (override) return override;
	if (!ctx.hasUI || !ctx.ui) return "cancel";
	const choices = layout.actions.map((action) => `${action.label}\n\n${action.description}`);
	const titleParts = [layout.title, "", layout.intro];
	if (layout.currentMissionHeading && layout.currentMissionBody) titleParts.push("", layout.currentMissionHeading, layout.currentMissionBody);
	if (layout.candidateMissionHeading && layout.candidateMissionBody) titleParts.push("", layout.candidateMissionHeading, layout.candidateMissionBody);
	if (layout.adoptedArtifactHeading && layout.adoptedArtifactBody) titleParts.push("", layout.adoptedArtifactHeading, layout.adoptedArtifactBody);
	const choice = await ctx.ui.select(titleParts.join("\n"), choices);
	if (!choice) return "cancel";
	const index = choices.indexOf(choice);
	return index >= 0 ? layout.actions[index].id : "cancel";
}

async function promptCookTriggerRecovery(
	ctx: InputRoutingContext,
	result: CookTriggerClassifierResult,
	deps: CompletionDriverDeps,
): Promise<CookTriggerRecoveryAction> {
	const override = triggerRecoveryOverride();
	const layout = buildCookTriggerRecoveryLayout({
		failureLabel: classifierFailureLabel(result),
		mainChatRerunGuidance: deps.mainChatRerunGuidance,
	});
	maybeWriteCookTriggerRecoverySnapshot(layout, triggerRecoverySnapshotPath());
	if (override) return override;
	if (!ctx.hasUI || !ctx.ui) return "cancel";
	const choices = layout.actions.map((action) => `${action.label}\n\n${action.description}`);
	const titleParts = [layout.title, "", layout.intro];
	if (layout.failureHeading && layout.failureBody) titleParts.push("", layout.failureHeading, layout.failureBody);
	const choice = await ctx.ui.select(titleParts.join("\n"), choices);
	if (!choice) return "cancel";
	const index = choices.indexOf(choice);
	return index >= 0 ? layout.actions[index].id : "cancel";
}

function buildHandoffHintText(
	classification: CookTriggerClassification,
	clarificationCapsule: CookNaturalLanguageHandoff["clarificationCapsule"] | undefined,
	adoptedArtifact: CookTriggerAdoptedArtifact | undefined,
): string | undefined {
	return clarificationCapsule?.goal ?? classification.focusHint ?? adoptedArtifact?.title;
}

export async function handleCookNaturalLanguageTrigger(
	pi: ExtensionAPI,
	event: InputRoutingEvent,
	ctx: InputRoutingContext,
	deps: CompletionDriverDeps,
): Promise<{ action: "continue" | "handled" } | { action: "transform"; text: string; images?: unknown[] }> {
	const replayText = consumeRouterBypassReplay(event);
	if (replayText !== undefined) {
		return { action: "transform", text: replayText, images: event.images };
	}

	const configuredMode = configuredTriggerMode();
	const mode = effectiveTriggerMode(configuredMode);
	if (mode === "off") {
		writeRoutingDecision(event, { mode: configuredMode, action: "continue", reason: "mode_off" });
		return { action: "continue" };
	}
	if (roleFromEnv()) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "completion_role_subprocess",
			bypassReason: "completion_role_subprocess",
		});
		return { action: "continue" };
	}
	if ((event.text ?? "").trimStart().startsWith("/")) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "slash_command",
			bypassReason: "slash_command",
		});
		return { action: "continue" };
	}
	if (event.source === "extension") {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "extension_source",
			bypassReason: "extension_source",
		});
		return { action: "continue" };
	}
	if (hasImages(event)) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "image_turn",
			bypassReason: "image_turn",
		});
		return { action: "continue" };
	}
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "non_idle_turn",
			bypassReason: "non_idle_turn",
		});
		return { action: "continue" };
	}

	const snapshot = await loadCompletionSnapshot(ctx.cwd);
	const root = snapshot?.files.root ?? ctx.cwd;
	const projectName = path.basename(root);
	const recentEntries = collectRecentDiscussionEntries(ctx, {
		asString,
		isRecord: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
	}, 6);
	const recentMessages = recentSessionMessages(ctx, 12);
	const adoptedArtifact = await detectExplicitAdoptedArtifact(event.text, ctx, root, recentMessages);
	const routerMode = mode === "router";
	if (!routerMode && !activeWorkflowContext(snapshot) && !hasRecentImplementationContext(recentEntries) && !adoptedArtifact) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "no_workflow_or_recent_implementation_context",
			bypassReason: "no_workflow_or_recent_implementation_context",
		}, routingExtrasForArtifact(adoptedArtifact));
		return { action: "continue" };
	}
	if (!routerMode && !looksLikeTriggerCandidate(event.text)) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "not_candidate",
			bypassReason: "not_candidate",
		}, routingExtrasForArtifact(adoptedArtifact));
		return { action: "continue" };
	}

	let classifier: CookTriggerClassifierResult | undefined;
	for (let attempt = 0; attempt < ROUTER_FAILURE_RETRY_LIMIT; attempt += 1) {
		classifier = await classifyCookTriggerIntentWithAgent({
			ctx,
			projectName,
			inputText: normalizeTriggerText(event.text),
			recentEntries,
			workflowContextLines: buildTriggerWorkflowContextLines(snapshot),
		});
		if (classifier.status === "classified" && classifier.classification) break;
		const recovery = await promptCookTriggerRecovery(ctx, classifier, deps);
		if (recovery === "retry_routing" && attempt + 1 < ROUTER_FAILURE_RETRY_LIMIT) {
			deps.emitCommandText(ctx, "Retrying workflow-aware router once before deciding whether /cook should take over.", "info");
			continue;
		}
		if (recovery === "send_as_normal_chat") {
			await replayOriginalMessageToPrimaryAgent(pi, event);
			deps.emitCommandText(ctx, "Replayed the original message once to the main chat path and bypassed router interception for that replay.", "info");
			writeRoutingDecision(event, {
				mode: configuredMode,
				action: "handled",
				reason: `${classifierFailureReason(classifier)}_send_as_normal_chat`,
			}, {
				...routingExtrasForArtifact(adoptedArtifact),
				recoveryAction: recovery,
				errorMessage: classifier.errorMessage ?? null,
				rawOutput: classifier.rawOutput ?? null,
				replayedToPrimaryAgent: true,
				replayBypassMarkerApplied: true,
			});
			return { action: "handled" };
		}
		deps.emitCommandText(
			ctx,
			"Cancelled router recovery without replaying the original message. If you want the completion workflow boundary, rerun /cook explicitly.",
			"info",
		);
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: `${classifierFailureReason(classifier)}_cancelled`,
		}, {
			...routingExtrasForArtifact(adoptedArtifact),
			recoveryAction: recovery,
			errorMessage: classifier.errorMessage ?? null,
			rawOutput: classifier.rawOutput ?? null,
			replayedToPrimaryAgent: false,
			replayBypassMarkerApplied: false,
		});
		return { action: "handled" };
	}

	if (!classifier || classifier.status !== "classified" || !classifier.classification) {
		deps.emitCommandText(ctx, "Router recovery stopped without replaying the original message. If you still want the workflow boundary, rerun /cook explicitly.", "info");
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: classifier ? `${classifierFailureReason(classifier)}_retry_exhausted` : "classifier_error_retry_exhausted",
		}, {
			...routingExtrasForArtifact(adoptedArtifact),
			recoveryAction: "retry_routing",
			errorMessage: classifier?.errorMessage ?? null,
			rawOutput: classifier?.rawOutput ?? null,
			replayedToPrimaryAgent: false,
			replayBypassMarkerApplied: false,
		});
		return { action: "handled" };
	}

	const classification = classifier.classification;
	if (classification.decision === "normal_prompt") {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "classifier_normal_prompt",
			classification,
		}, routingExtrasForArtifact(adoptedArtifact));
		return { action: "continue" };
	}

	const proposalHint = buildAdoptedArtifactHint(adoptedArtifact);
	if (classification.decision === "unclear") {
		const proposal = await deps.deriveCookContextProposal(ctx, projectName, proposalHint);
		const clarification = await promptCookTriggerClarification(ctx, snapshot, proposal, adoptedArtifact, deps);
		if (clarification === "send_as_normal_chat") {
			await replayOriginalMessageToPrimaryAgent(pi, event);
			deps.emitCommandText(ctx, "Replayed the original message once to the main chat path and bypassed router interception for that clarification replay.", "info");
			writeRoutingDecision(event, {
				mode: configuredMode,
				action: "handled",
				reason: "user_sent_as_normal_chat_after_clarification",
				classification,
			}, {
				...routingExtrasForArtifact(adoptedArtifact),
				clarificationAction: clarification,
				replayedToPrimaryAgent: true,
				replayBypassMarkerApplied: true,
			});
			return { action: "handled" };
		}
		if (clarification === "cancel") {
			deps.emitCommandText(
				ctx,
				"Cancelled commandless workflow clarification. If you want the workflow boundary, rerun /cook explicitly.",
				"info",
			);
			writeRoutingDecision(event, {
				mode: configuredMode,
				action: "handled",
				reason: triggerClarificationOverride() ? "user_cancelled_clarification" : ctx.hasUI ? "user_cancelled_clarification" : "clarification_unavailable",
				classification,
			}, {
				...routingExtrasForArtifact(adoptedArtifact),
				clarificationAction: clarification,
				replayedToPrimaryAgent: false,
				replayBypassMarkerApplied: false,
			});
			return { action: "handled" };
		}
		const clarificationCapsule = buildClarificationCapsule(clarification, classification, proposal);
		const selectedBias = clarificationBiasFromAction(clarification) ?? classification.workflowBias;
		deps.emitCommandText(ctx, "Routing clarified natural-language handoff into /cook.", "info");
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "routed_to_cook",
			reason: "clarification_resolved",
			classification,
		}, {
			...routingExtrasForArtifact(adoptedArtifact),
			...routingExtrasForClarification(clarificationCapsule),
			clarificationAction: clarification,
		});
		await runCookEntry(pi, ctx, deps, {
			origin: "natural-language-trigger",
			hintText: buildHandoffHintText(classification, clarificationCapsule, adoptedArtifact),
			originalInput: event.text,
			triggerText: event.text,
			preferredRoutingBias: selectedBias,
			clarificationCapsule,
			adoptedArtifact,
		});
		return { action: "handled" };
	}

	const confirmation = await promptCookTriggerTakeover(ctx, classification, deps);
	if (confirmation === "send_as_normal_chat") {
		await replayOriginalMessageToPrimaryAgent(pi, event);
		deps.emitCommandText(ctx, "Replayed the original message once to the main chat path and bypassed router interception for that workflow-offer replay.", "info");
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: "user_sent_as_normal_chat",
			classification,
		}, {
			...routingExtrasForArtifact(adoptedArtifact),
			confirmationAction: confirmation,
			replayedToPrimaryAgent: true,
			replayBypassMarkerApplied: true,
		});
		return { action: "handled" };
	}
	if (confirmation === "cancel") {
		deps.emitCommandText(
			ctx,
			"Cancelled natural-language /cook takeover. If you want the workflow boundary, rerun /cook explicitly.",
			"info",
		);
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: ctx.hasUI ? "user_cancelled_takeover" : "assist_confirmation_unavailable",
			classification,
		}, {
			...routingExtrasForArtifact(adoptedArtifact),
			confirmationAction: confirmation,
			replayedToPrimaryAgent: false,
			replayBypassMarkerApplied: false,
		});
		return { action: "handled" };
	}

	deps.emitCommandText(ctx, "Routing natural-language handoff into /cook.", "info");
	writeRoutingDecision(event, {
		mode: configuredMode,
		action: "routed_to_cook",
		reason: "accepted_takeover",
		classification,
	}, {
		...routingExtrasForArtifact(adoptedArtifact),
		confirmationAction: confirmation,
	});
	await runCookEntry(pi, ctx, deps, {
		origin: "natural-language-trigger",
		hintText: buildHandoffHintText(classification, undefined, adoptedArtifact),
		originalInput: event.text,
		triggerText: event.text,
		preferredRoutingBias: classification.workflowBias,
		adoptedArtifact,
	});
	return { action: "handled" };
}
