import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runCookEntry, type CompletionDriverDeps } from "./driver";
import {
	buildCookTriggerAssistConfirmationLayout,
	maybeWriteCookTriggerConfirmationSnapshot,
	maybeWriteCookTriggerRoutingSnapshot,
} from "./prompt-surfaces";
import {
	collectRecentDiscussionEntries,
	hasRecentDiscussionImplementationIntent,
	stripCodeBlocks,
} from "./proposal";
import {
	classifyCookTriggerIntentWithAgent,
	type CookTriggerClassifierResult,
} from "./role-runner";
import { asString, loadCompletionSnapshot } from "./state-store";
import type {
	CompletionStateSnapshot,
	CookTriggerClassification,
	CookTriggerConfirmationAction,
	CookTriggerDecision,
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

const MAX_TRIGGER_CANDIDATE_LENGTH = 120;
const MAX_TRIGGER_CANDIDATE_LINES = 3;
const CLEAR_TRIGGER_PATTERNS = [
	/^(?:go ahead|please go ahead|proceed|let'?s do it|let'?s start|start(?: implementing| implementation| the workflow| the next round)?|begin(?: implementing| implementation| the workflow| the next round)?|continue(?: with implementation| implementing| the workflow)?|resume(?: the workflow| where we left off)?|next step|work on it|do it|ship it|let'?s do this instead|switch to this)\b/i,
	/^(?:開始(?:做|實作|实现|落地|下一輪)|开始(?:做|实作|实现|落地|下一轮)|那就做吧|照(?:剛剛|刚刚|這個|这个|上述|上面的)?(?:討論|讨论|方向).*(?:做|實作|实现|落地)|可以開始(?:做|實作|实现|下一輪)?|可以开始(?:做|实作|实现|下一轮)?|繼續(?:做|實作|实现|往下做)|继续(?:做|实作|实现|往下做)|接著(?:做|實作|实现)|接着(?:做|实作|实现)|下一步|那改做(?:這個|这个)|先做新的那個方向|先做新的那个方向|好，開始做這個|好，开始做这个)/u,
];
const AMBIGUOUS_ACK_PATTERNS = [/^(?:ok|okay|sure|fine|yes|yeah|yep)$/i, /^(?:好|好的|可以|嗯|那就這樣|那就这样|就這樣|就这样|先這樣|先这样|收到)$/u];

function roleFromEnv(): string | undefined {
	return asString(process.env.PI_COMPLETION_ROLE);
}

function configuredTriggerMode(): NaturalLanguageCookTriggerMode {
	const raw =
		asString(process.env.PI_COMPLETION_TEST_TRIGGER_MODE)?.toLowerCase() ??
		asString(process.env.PI_COMPLETION_TRIGGER_MODE)?.toLowerCase() ??
		"assist";
	return raw === "off" || raw === "assist" || raw === "auto" ? raw : "assist";
}

function effectiveTriggerMode(mode: NaturalLanguageCookTriggerMode): "off" | "assist" {
	return mode === "off" ? "off" : "assist";
}

function triggerRoutingSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH);
}

function triggerConfirmationSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH);
}

function triggerConfirmationOverride(): CookTriggerConfirmationAction | undefined {
	const raw = asString(process.env.PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION)?.toLowerCase();
	if (!raw) return undefined;
	if (raw === "start" || raw === "start_cook" || raw === "start_workflow" || raw === "cook") return "start_workflow";
	if (raw === "continue" || raw === "keep_chatting" || raw === "keep-chatting") return "keep_chatting";
	if (raw === "cancel" || raw === "dismiss") return "cancel";
	return undefined;
}

function normalizeTriggerText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function hasImages(event: InputRoutingEvent): boolean {
	return Array.isArray(event.images) && event.images.length > 0;
}

function activeWorkflowContext(snapshot: CompletionStateSnapshot | undefined): boolean {
	return Boolean(snapshot) && asString(snapshot?.state?.continuation_policy) !== "done";
}

function looksLikeTriggerCandidate(text: string): boolean {
	const normalized = normalizeTriggerText(text);
	if (!normalized) return false;
	if (normalized.length > MAX_TRIGGER_CANDIDATE_LENGTH) return false;
	if (text.split(/\r?\n/).length > MAX_TRIGGER_CANDIDATE_LINES) return false;
	if (normalized.startsWith("/") || normalized.startsWith("!")) return false;
	if (AMBIGUOUS_ACK_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	return CLEAR_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized));
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

function guidanceForClassifierFailure(result: CookTriggerClassifierResult): string {
	if (result.status === "timeout") {
		return "Could not safely determine whether /cook should take over before implementation work started because the trigger classifier timed out. If you want the completion workflow boundary, run /cook explicitly.";
	}
	return "Could not safely determine whether /cook should take over before implementation work started. If you want the completion workflow boundary, run /cook explicitly.";
}

export async function handleCookNaturalLanguageTrigger(
	pi: ExtensionAPI,
	event: InputRoutingEvent,
	ctx: InputRoutingContext,
	deps: CompletionDriverDeps,
): Promise<{ action: "continue" | "handled" }> {
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
	const recentEntries = collectRecentDiscussionEntries(ctx, {
		asString,
		isRecord: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
	}, 6);
	if (!activeWorkflowContext(snapshot) && !hasRecentImplementationContext(recentEntries)) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "no_workflow_or_recent_implementation_context",
			bypassReason: "no_workflow_or_recent_implementation_context",
		});
		return { action: "continue" };
	}
	if (!looksLikeTriggerCandidate(event.text)) {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "not_candidate",
			bypassReason: "not_candidate",
		});
		return { action: "continue" };
	}

	const classifier = await classifyCookTriggerIntentWithAgent({
		ctx,
		projectName: path.basename(snapshot?.files.root ?? ctx.cwd),
		inputText: normalizeTriggerText(event.text),
		recentEntries,
		workflowContextLines: buildTriggerWorkflowContextLines(snapshot),
	});
	if (classifier.status !== "classified" || !classifier.classification) {
		deps.emitCommandText(ctx, guidanceForClassifierFailure(classifier), "info");
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: classifierFailureReason(classifier),
		}, {
			errorMessage: classifier.errorMessage ?? null,
			rawOutput: classifier.rawOutput ?? null,
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
		});
		return { action: "continue" };
	}
	if (classification.decision === "unclear") {
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "continue",
			reason: "classifier_unclear",
			classification,
		});
		return { action: "continue" };
	}

	const confirmation = await promptCookTriggerTakeover(ctx, classification, deps);
	if (confirmation === "keep_chatting") {
		deps.emitCommandText(
			ctx,
			"Kept the workflow offer side-effect free. Continue the discussion in the main chat and send a fresh message when you are ready to enter /cook.",
			"info",
		);
		writeRoutingDecision(event, {
			mode: configuredMode,
			action: "handled",
			reason: "user_kept_chatting",
			classification,
		}, {
			confirmationAction: confirmation,
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
			confirmationAction: confirmation,
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
		confirmationAction: confirmation,
	});
	await runCookEntry(pi, ctx, deps, {
		origin: "natural-language-trigger",
		hintText: classification.focusHint,
		originalInput: event.text,
		triggerText: event.text,
		preferredRoutingBias: classification.workflowBias,
	});
	return { action: "handled" };
}
