import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CompletionStateSnapshot,
	CookNaturalLanguageHandoff,
	CookTriggerAdoptedArtifact,
	CookTriggerClarificationActionItem,
	CookTriggerClarificationLayout,
	CookTriggerClassification,
	CookTriggerConfirmationActionItem,
	CookTriggerConfirmationLayout,
	CookTriggerRecoveryActionItem,
	CookTriggerRecoveryLayout,
	CookTriggerWorkflowBias,
	LiveRoleActivity,
} from "./types";
import type {
	ContextProposal,
	ContextProposalAnalysis,
	ContextProposalConfirmationActionItem,
	ContextProposalConfirmationLayout,
} from "./proposal";

export function buildContextProposalGoalText(proposal: {
	mission: string;
	scope: string[];
	constraints: string[];
	acceptance: string[];
}): string {
	const lines = [`Mission: ${proposal.mission}`];
	if (proposal.scope.length > 0) {
		lines.push("", "Scope:");
		for (const item of proposal.scope) lines.push(`- ${item}`);
	}
	if (proposal.constraints.length > 0) {
		lines.push("", "Constraints:");
		for (const item of proposal.constraints) lines.push(`- ${item}`);
	}
	if (proposal.acceptance.length > 0) {
		lines.push("", "Acceptance:");
		for (const item of proposal.acceptance) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}

export function buildContextProposalDisplayText(proposal: ContextProposal): string {
	const lines = ["Mission", proposal.mission];
	if (proposal.scope.length > 0) {
		lines.push("", "Scope");
		for (const item of proposal.scope) lines.push(`- ${item}`);
	}
	if (proposal.constraints.length > 0) {
		lines.push("", "Constraints");
		for (const item of proposal.constraints) lines.push(`- ${item}`);
	}
	if (proposal.acceptance.length > 0) {
		lines.push("", "Acceptance");
		for (const item of proposal.acceptance) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}

export function buildContextProposalCritiqueText(analysis: ContextProposalAnalysis): string {
	const lines: string[] = [];
	if (analysis.critique.length > 0) {
		lines.push("Critique");
		for (const item of analysis.critique) lines.push(`- ${item}`);
	}
	if (analysis.risks.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Risks");
		for (const item of analysis.risks) lines.push(`- ${item}`);
	}
	if (analysis.possibleNoise.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Possible noise");
		for (const item of analysis.possibleNoise) lines.push(`- ${item}`);
	}
	if (analysis.alternateMissions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Alternate recent missions");
		for (const item of analysis.alternateMissions) lines.push(`- ${item}`);
	}
	if (analysis.suppressedCompletedTopics.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Suppressed completed topics");
		for (const item of analysis.suppressedCompletedTopics) lines.push(`- ${item}`);
	}
	if (analysis.suppressedNegatedTopics.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Suppressed negated topics");
		for (const item of analysis.suppressedNegatedTopics) lines.push(`- ${item}`);
	}
	if (lines.length === 0) {
		return "No critique, risk, noise, alternate-mission, or suppression notes were derived for this startup proposal.";
	}
	return lines.join("\n");
}

export function buildContextProposalRoutingText(
	analysis: ContextProposalAnalysis,
	defaults: { taskType: string; evaluationProfile: string },
): string {
	return [`- task_type: ${analysis.taskType ?? defaults.taskType}`, `- evaluation_profile: ${analysis.evaluationProfile ?? defaults.evaluationProfile}`].join(
		"\n",
	);
}

function summarizeContextProposalAnalysisItems(
	label: string,
	items: string[],
	truncateInline: (text: string, maxLength?: number) => string,
): string | undefined {
	if (items.length === 0) return undefined;
	return `${label}=${truncateInline(items.join(" | "), 160)}`;
}

export function buildContextProposalContinuationReason(
	prefix: string,
	goalText: string,
	analysis: ContextProposalAnalysis,
	deps: {
		defaultTaskType: string;
		defaultEvaluationProfile: string;
		truncateInline: (text: string, maxLength?: number) => string;
	},
): string {
	const critiqueParts = [
		analysis.critique.length > 0 ? `accepted critique=${deps.truncateInline(analysis.critique.join(" | "), 160)}` : "accepted critique=none",
		summarizeContextProposalAnalysisItems("risks", analysis.risks, deps.truncateInline),
		summarizeContextProposalAnalysisItems("possible_noise", analysis.possibleNoise, deps.truncateInline),
		summarizeContextProposalAnalysisItems("alternate_missions", analysis.alternateMissions, deps.truncateInline),
		summarizeContextProposalAnalysisItems("suppressed_completed", analysis.suppressedCompletedTopics, deps.truncateInline),
		summarizeContextProposalAnalysisItems("suppressed_negated", analysis.suppressedNegatedTopics, deps.truncateInline),
	].filter((part): part is string => Boolean(part));
	return `${prefix} ${deps.truncateInline(goalText, 220)} | startup routing: task_type=${analysis.taskType ?? deps.defaultTaskType}; evaluation_profile=${analysis.evaluationProfile ?? deps.defaultEvaluationProfile}; critique outcome=${critiqueParts.join("; ")}`;
}

export function buildContextProposalConfirmationActions(mainChatRerunGuidance: string): ContextProposalConfirmationActionItem[] {
	return [
		{
			id: "start",
			label: "Start",
			description: "Accept this proposal and let /cook write or refocus canonical workflow state.",
		},
		{
			id: "cancel",
			label: "Cancel",
			description: `Stop here without changing canonical workflow state. ${mainChatRerunGuidance}`,
		},
	];
}

export function buildContextProposalConfirmationLayout(args: {
	title: string;
	proposal: ContextProposal;
	analysis: ContextProposalAnalysis;
	mainChatRerunGuidance: string;
	defaultTaskType: string;
	defaultEvaluationProfile: string;
}): ContextProposalConfirmationLayout {
	return {
		title: args.title,
		intro: "Review the proposed mission, scope, constraints, acceptance, critique, and routing details before /cook writes canonical workflow state. This gate is approval-only: either Start it as-is or Cancel, discuss changes in the main chat, and rerun /cook.",
		proposalHeading: "Proposed workflow",
		proposalBody: buildContextProposalDisplayText(args.proposal),
		critiqueHeading: "Critique and risks",
		critiqueBody: buildContextProposalCritiqueText(args.analysis),
		routingHeading: "Routing recommendations",
		routingBody: buildContextProposalRoutingText(args.analysis, {
			taskType: args.defaultTaskType,
			evaluationProfile: args.defaultEvaluationProfile,
		}),
		actionsHeading: "Actions",
		actions: buildContextProposalConfirmationActions(args.mainChatRerunGuidance),
		footer: "↑↓ navigate • enter select • esc cancel",
	};
}

export function maybeWriteContextProposalConfirmationSnapshot(
	layout: ContextProposalConfirmationLayout,
	snapshotPath: string | undefined,
): void {
	if (!snapshotPath) return;
	try {
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(snapshotPath, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
	} catch {
		// ignore malformed or unwritable test snapshot paths
	}
}

export function maybeWriteContextProposalSnapshot(proposal: ContextProposal, snapshotPath: string | undefined): void {
	if (!snapshotPath) return;
	try {
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(snapshotPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
	} catch {
		// ignore malformed or unwritable test snapshot paths
	}
}

function writeJsonSnapshot(snapshotPath: string | undefined, value: unknown): void {
	if (!snapshotPath) return;
	try {
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(snapshotPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	} catch {
		// ignore malformed or unwritable test snapshot paths
	}
}

export function buildCookTriggerClassifierPrompt(args: {
	projectName: string;
	inputText: string;
	recentDiscussion: string;
	workflowContextLines?: string[];
}): string {
	const lines = [
		`Project: ${args.projectName}`,
		"Classify whether the current input should stay in the main chat or be intercepted by the workflow-aware router into the canonical /cook workflow before the primary agent starts implementation work.",
		"Assume router mode reviews every non-bypass normal user turn. Do not require short trigger phrases or explicit /cook text before choosing offer_workflow.",
		"Return JSON only with keys: decision, confidence, workflow_bias, reason, evidence, riskFlags, focusHint. You may also include optional keys requires_clarification, clarification_slots, and adopted_artifact when clearly supported.",
		"decision must be exactly one of offer_workflow, normal_prompt, or unclear.",
		"Use offer_workflow when the user is directly asking to start, resume, refocus, or continue workflow-worthy repo work through the completion boundary, or explicitly asking to let /cook take over.",
		"Use normal_prompt for ordinary questions, explanations, analysis-only requests, or direct agent requests that should stay in the main chat.",
		"Use unclear for ambiguous approvals, short acknowledgements, or cases where false-positive routing risk is material.",
		"workflow_bias must be exactly one of startup, resume, refocus, next_round, or unknown.",
		"Use startup when there is no active workflow yet, resume when the user is clearly continuing the current workflow, refocus when the user is clearly switching the active workflow to a different goal, and next_round when the previous workflow is done and the user is starting a new round.",
		"When decision is not offer_workflow, prefer workflow_bias=unknown unless a stronger routing hint is still useful for later debugging.",
		"focusHint is optional, must stay short, and must never rewrite the workflow mission or invent scope.",
		"When explicit user adoption of a recent plan or repo markdown artifact is evident, adopted_artifact may describe it with kind recent_plan|repo_markdown, path when known, and basis explicit_user_adoption.",
		"requires_clarification may be true when chooser-style disambiguation is safer than guessing, and clarification_slots may list short needs such as goal, scope, or non_goal.",
		"evidence and riskFlags must be arrays of short grounded strings.",
	];
	if (args.workflowContextLines?.length) lines.push("", "Canonical workflow context:", ...args.workflowContextLines);
	lines.push("", `Current input: ${args.inputText}`, "", "Recent discussion:", args.recentDiscussion || "(none)");
	return lines.join("\n");
}

function cookTriggerOfferCopyForBias(
	workflowBias: CookTriggerWorkflowBias,
	mainChatRerunGuidance: string,
): { title: string; intro: string; startAction: CookTriggerConfirmationActionItem; sendAsNormalChat: CookTriggerConfirmationActionItem; cancel: CookTriggerConfirmationActionItem } {
	switch (workflowBias) {
		case "startup":
			return {
				title: "Start a completion workflow from the recent discussion?",
				intro:
					"This input looks like a startup handoff into the completion workflow. The shared /cook entry would initialize or continue the canonical workflow boundary only after you confirm.",
				startAction: {
					id: "start_workflow",
					label: "Start workflow",
					description: "Enter the shared /cook workflow entry from the recent discussion before the primary agent starts implementation work.",
				},
				sendAsNormalChat: {
					id: "send_as_normal_chat",
					label: "Send as normal chat",
					description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
				},
				cancel: {
					id: "cancel",
					label: "Cancel",
					description: `Stop here without routing or replaying the original message. ${mainChatRerunGuidance}`,
				},
			};
		case "resume":
			return {
				title: "Resume the current completion workflow?",
				intro:
					"This input looks like a resume handoff for the current completion workflow. The shared /cook entry would continue from canonical state only after you confirm.",
				startAction: {
					id: "start_workflow",
					label: "Resume workflow",
					description: "Resume the current canonical completion workflow through the shared /cook entry.",
				},
				sendAsNormalChat: {
					id: "send_as_normal_chat",
					label: "Send as normal chat",
					description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
				},
				cancel: {
					id: "cancel",
					label: "Cancel",
					description: `Stop here without resuming or replaying the original message. ${mainChatRerunGuidance}`,
				},
			};
		case "refocus":
			return {
				title: "Refocus the completion workflow from the recent discussion?",
				intro:
					"This input looks like a refocus handoff. The shared /cook entry would keep the existing chooser and confirmation semantics before any canonical workflow state is rewritten.",
				startAction: {
					id: "start_workflow",
					label: "Refocus workflow",
					description: "Review the recent discussion through the shared /cook entry and refocus the canonical workflow only if the follow-up confirmations agree.",
				},
				sendAsNormalChat: {
					id: "send_as_normal_chat",
					label: "Send as normal chat",
					description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
				},
				cancel: {
					id: "cancel",
					label: "Cancel",
					description: `Stop here without refocusing or replaying the original message. ${mainChatRerunGuidance}`,
				},
			};
		case "next_round":
			return {
				title: "Start the next completion workflow round from the recent discussion?",
				intro:
					"This input looks like a next-round handoff after a completed workflow. The shared /cook entry would preserve the same canonical workflow boundary while starting the next round only after you confirm.",
				startAction: {
					id: "start_workflow",
					label: "Start next round",
					description: "Start the next workflow round through the shared /cook entry using the recent discussion as the new focus.",
				},
				sendAsNormalChat: {
					id: "send_as_normal_chat",
					label: "Send as normal chat",
					description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
				},
				cancel: {
					id: "cancel",
					label: "Cancel",
					description: `Stop here without starting a new workflow round or replaying the original message. ${mainChatRerunGuidance}`,
				},
			};
		case "unknown":
		default:
			return {
				title: "Let the completion workflow take over from the recent discussion?",
				intro:
					"This input looks like a natural-language handoff into the completion workflow. The shared /cook entry would keep the existing approval-only startup, continue, refocus, and next-round semantics before canonical state changes.",
				startAction: {
					id: "start_workflow",
					label: "Start workflow",
					description: "Enter the shared /cook workflow entry before the primary agent starts implementation work.",
				},
				sendAsNormalChat: {
					id: "send_as_normal_chat",
					label: "Send as normal chat",
					description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
				},
				cancel: {
					id: "cancel",
					label: "Cancel",
					description: `Stop here without routing or replaying the original message. ${mainChatRerunGuidance}`,
				},
			};
	}
}

export function buildCookTriggerConfirmationActions(
	workflowBias: CookTriggerWorkflowBias,
	mainChatRerunGuidance: string,
): CookTriggerConfirmationActionItem[] {
	const copy = cookTriggerOfferCopyForBias(workflowBias, mainChatRerunGuidance);
	return [copy.startAction, copy.sendAsNormalChat, copy.cancel];
}

function summarizeAdoptedArtifact(adoptedArtifact: CookTriggerAdoptedArtifact | undefined): string | undefined {
	if (!adoptedArtifact) return undefined;
	const lines = [
		`- kind: ${adoptedArtifact.kind}`,
		`- basis: ${adoptedArtifact.basis}`,
		`- title: ${adoptedArtifact.title}`,
	];
	if (adoptedArtifact.path) lines.push(`- path: ${adoptedArtifact.path}`);
	if (adoptedArtifact.preview) lines.push(`- preview: ${adoptedArtifact.preview}`);
	return lines.join("\n");
}

export function buildCookTriggerClarificationLayout(args: {
	currentMission?: string;
	candidateMission?: string;
	workflowBiases: CookTriggerWorkflowBias[];
	mainChatRerunGuidance: string;
	adoptedArtifact?: CookTriggerAdoptedArtifact;
}): CookTriggerClarificationLayout {
	const actions: CookTriggerClarificationActionItem[] = [];
	if (args.workflowBiases.includes("startup")) {
		actions.push({
			id: "route_startup",
			label: "Start workflow",
			description: "Treat this as a startup handoff into the shared /cook workflow from the recent discussion.",
		});
	}
	if (args.workflowBiases.includes("resume")) {
		actions.push({
			id: "route_resume",
			label: "Resume workflow",
			description: "Keep the current canonical mission and resume the active workflow through the shared /cook entry.",
		});
	}
	if (args.workflowBiases.includes("refocus")) {
		actions.push({
			id: "route_refocus",
			label: "Refocus from recent discussion",
			description: "Route into the shared /cook entry and keep its existing chooser + approval flow before any canonical state rewrite.",
		});
	}
	if (args.workflowBiases.includes("next_round")) {
		actions.push({
			id: "route_next_round",
			label: "Start next round",
			description: "Treat this as a next-round handoff into the shared /cook entry after the finished workflow.",
		});
	}
	actions.push(
		{
			id: "send_as_normal_chat",
			label: "Send as normal chat",
			description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
		},
		{
			id: "cancel",
			label: "Cancel",
			description: `Stop here without routing or replaying the original message. ${args.mainChatRerunGuidance}`,
		},
	);
	return {
		title: "Clarify how the completion workflow should proceed",
		intro:
			"This start-intent looks workflow-related, but not enough to safely choose startup, resume, refocus, or next-round automatically. Pick the minimal next step or cancel without changing canonical workflow state.",
		currentMissionHeading: args.currentMission ? "Current mission" : undefined,
		currentMissionBody: args.currentMission,
		candidateMissionHeading: args.candidateMission ? "Recent-discussion candidate" : undefined,
		candidateMissionBody: args.candidateMission,
		adoptedArtifactHeading: args.adoptedArtifact ? "Adopted artifact" : undefined,
		adoptedArtifactBody: summarizeAdoptedArtifact(args.adoptedArtifact),
		actionsHeading: "Actions",
		actions,
		footer: "↑↓ navigate • enter select • esc cancel",
	};
}

export function buildCookTriggerAssistConfirmationLayout(args: {
	classification: CookTriggerClassification;
	mainChatRerunGuidance: string;
}): CookTriggerConfirmationLayout {
	const evidenceBody =
		args.classification.evidence.length > 0
			? args.classification.evidence.map((item) => `- ${item}`).join("\n")
			: "- No additional evidence was captured beyond the current handoff signal.";
	const riskBody = args.classification.riskFlags.length > 0 ? args.classification.riskFlags.map((item) => `- ${item}`).join("\n") : undefined;
	const copy = cookTriggerOfferCopyForBias(args.classification.workflowBias, args.mainChatRerunGuidance);
	return {
		title: copy.title,
		intro: copy.intro,
		evidenceHeading: "Why it matched",
		evidenceBody,
		riskHeading: riskBody ? "Risk checks" : undefined,
		riskBody,
		focusHintHeading: args.classification.focusHint ? "Optional focus hint" : undefined,
		focusHintBody: args.classification.focusHint,
		actionsHeading: "Actions",
		actions: [copy.startAction, copy.sendAsNormalChat, copy.cancel],
		footer: "↑↓ navigate • enter select • esc cancel",
	};
}

export function buildCookTriggerRecoveryLayout(args: {
	failureLabel: string;
	mainChatRerunGuidance: string;
}): CookTriggerRecoveryLayout {
	const actions: CookTriggerRecoveryActionItem[] = [
		{
			id: "retry_routing",
			label: "Retry routing",
			description: "Run the workflow-aware router classifier once more before deciding whether /cook should take over.",
		},
		{
			id: "send_as_normal_chat",
			label: "Send as normal chat",
			description: "Replay the original message exactly once to the primary agent and bypass router interception for that replay.",
		},
		{
			id: "cancel",
			label: "Cancel",
			description: `Stop here without routing or replaying the original message. ${args.mainChatRerunGuidance}`,
		},
	];
	return {
		title: "Router recovery needed before this prompt can continue",
		intro:
			"The workflow-aware router could not safely classify this prompt, so it stayed fail-closed instead of silently sending the prompt to the primary agent. Choose an explicit recovery path or cancel.",
		failureHeading: "Router failure",
		failureBody: args.failureLabel,
		actionsHeading: "Actions",
		actions,
		footer: "↑↓ navigate • enter select • esc cancel",
	};
}

export function maybeWriteCookTriggerClassifierSnapshot(snapshot: Record<string, unknown>, snapshotPath: string | undefined): void {
	writeJsonSnapshot(snapshotPath, snapshot);
}

export function maybeWriteCookTriggerConfirmationSnapshot(
	layout: CookTriggerConfirmationLayout,
	snapshotPath: string | undefined,
): void {
	writeJsonSnapshot(snapshotPath, layout);
}

export function maybeWriteCookTriggerClarificationSnapshot(
	layout: CookTriggerClarificationLayout,
	snapshotPath: string | undefined,
): void {
	writeJsonSnapshot(snapshotPath, layout);
}

export function maybeWriteCookTriggerRecoverySnapshot(layout: CookTriggerRecoveryLayout, snapshotPath: string | undefined): void {
	writeJsonSnapshot(snapshotPath, layout);
}

export function maybeWriteCookTriggerRoutingSnapshot(snapshot: Record<string, unknown>, snapshotPath: string | undefined): void {
	writeJsonSnapshot(snapshotPath, snapshot);
}

function buildNaturalLanguageHandoffArtifactLines(adoptedArtifact: CookTriggerAdoptedArtifact | undefined): string[] {
	if (!adoptedArtifact) return [];
	const lines = [
		`- adopted_artifact_kind: ${adoptedArtifact.kind}`,
		`- adopted_artifact_basis: ${adoptedArtifact.basis}`,
		`- adopted_artifact_title: ${adoptedArtifact.title}`,
	];
	if (adoptedArtifact.path) lines.push(`- adopted_artifact_path: ${adoptedArtifact.path}`);
	if (adoptedArtifact.preview) lines.push(`- adopted_artifact_preview: ${adoptedArtifact.preview}`);
	return lines;
}

function buildNaturalLanguageHandoffClarificationLines(
	clarificationCapsule: CookNaturalLanguageHandoff["clarificationCapsule"] | undefined,
): string[] {
	if (!clarificationCapsule) return [];
	const lines = [
		`- clarification_selected_bias: ${clarificationCapsule.selectedWorkflowBias}`,
		`- clarification_reason: ${clarificationCapsule.reason}`,
	];
	if (clarificationCapsule.goal) lines.push(`- clarification_goal: ${clarificationCapsule.goal}`);
	if (clarificationCapsule.scope?.length) lines.push(`- clarification_scope: ${clarificationCapsule.scope.join(" | ")}`);
	if (clarificationCapsule.nonGoal?.length) lines.push(`- clarification_non_goal: ${clarificationCapsule.nonGoal.join(" | ")}`);
	if (clarificationCapsule.doneWhen?.length) lines.push(`- clarification_done_when: ${clarificationCapsule.doneWhen.join(" | ")}`);
	return lines;
}

export function buildNaturalLanguageHandoffMetadataLines(handoff: CookNaturalLanguageHandoff | undefined): string[] {
	if (!handoff) return [];
	return [
		"Natural-language handoff metadata:",
		`- source: natural_language_handoff`,
		`- preferred_routing_bias: ${handoff.preferredRoutingBias ?? "unknown"}`,
		`- trigger_text: ${handoff.triggerText ?? "(none)"}`,
		`- focus_hint: ${handoff.hintText ?? "(none)"}`,
		...buildNaturalLanguageHandoffArtifactLines(handoff.adoptedArtifact),
		...buildNaturalLanguageHandoffClarificationLines(handoff.clarificationCapsule),
		"",
	];
}

export function buildContextProposalConfirmationSelectItems(layout: ContextProposalConfirmationLayout) {
	return layout.actions.map((action) => ({
		value: action.id,
		label: action.label,
		description: action.description,
	}));
}

export function buildContextProposalAnalystPrompt(projectName: string, discussion: string, contextLines: string[] = []): string {
	const lines = [
		`Project: ${projectName}`,
		"Infer the current implementation mission from the discussion.",
		"Prefer the latest clear user implementation intent over older background context.",
		"Treat stale, completed, or explicitly negated topics as context to ignore unless the latest discussion clearly reopens them.",
		"If canonical workflow context includes a /cook hint, use it as a high-priority cue for how to interpret the recent discussion without treating it as an unconditional override.",
	];
	if (contextLines.length > 0) lines.push("", "Canonical workflow context:", ...contextLines);
	lines.push("", "Recent discussion:", discussion || "(none)");
	return lines.join("\n");
}

export function contextProposalAnalystProgressLines(
	activity: LiveRoleActivity,
	buildInlineRunningLines: (details: {
		role?: string;
		startedAt?: number;
		updatedAt?: number;
		currentAction?: string;
		toolActivity?: string[];
		toolRecentActivity?: string[];
		recentActivity?: string[];
		assistantSummary?: string;
		progress?: string;
		rationale?: string;
		nextStep?: string;
		verifying?: string;
		stateDeltas?: string[];
	}) => string[],
): string[] {
	return [
		...buildInlineRunningLines({
			role: activity.role,
			startedAt: activity.startedAt,
			updatedAt: activity.updatedAt,
			currentAction: activity.currentAction,
			toolActivity: activity.toolActivity,
			toolRecentActivity: activity.toolRecentActivity,
			recentActivity: activity.recentActivity,
			assistantSummary: activity.assistantSummary,
			progress: activity.progress,
			rationale: activity.rationale,
			nextStep: activity.nextStep,
			verifying: activity.verifying,
			stateDeltas: activity.stateDeltas,
		}),
		"",
		"This step only prepares a proposal for confirmation.",
	];
}

export function buildEvaluationRoleContextLines(
	snapshot: CompletionStateSnapshot,
	role: string,
	deps: {
		asString: (value: unknown) => string | undefined;
		currentTaskType: (snapshot: CompletionStateSnapshot) => string | undefined;
		currentEvaluationProfile: (snapshot: CompletionStateSnapshot) => string | undefined;
		activeSliceContext: (snapshot: CompletionStateSnapshot) => {
			sliceId?: string;
			status?: string;
			goal?: string;
			contractIds: string[];
			acceptance: string[];
			implementationSurfaces: string[];
			verificationCommands: string[];
			lockedNotes: string[];
			mustFixFindings: string[];
			remainingBefore: string[];
			basisCommit?: string;
			releaseBlockerCountBefore?: number;
			highValueGapCountBefore?: number;
		};
		verificationEvidenceContext: (snapshot: CompletionStateSnapshot) => {
			path: string;
			status: string;
			subjectType?: string;
			sliceId?: string;
			contractIds: string[];
			outcome?: string;
			recordedAt?: string;
			headSha?: string;
			basisCommit?: string;
			verificationCommands: string[];
			summary: string;
		};
	},
): string[] {
	const context = deps.activeSliceContext(snapshot);
	const evidence = deps.verificationEvidenceContext(snapshot);
	return [
		`Canonical evaluation handoff for ${role}:`,
		`- task_type: ${deps.currentTaskType(snapshot) ?? "(missing)"}`,
		`- evaluation_profile: ${deps.currentEvaluationProfile(snapshot) ?? "(missing)"}`,
		`- latest_completed_slice: ${deps.asString(snapshot.state?.latest_completed_slice) ?? "(none)"}`,
		`- active_slice_id: ${context.sliceId ?? "(none)"}`,
		`- active_slice_status: ${context.status ?? "(unknown)"}`,
		`- active_slice_goal: ${context.goal ?? "(unknown)"}`,
		`- contract_ids: ${context.contractIds.length > 0 ? context.contractIds.join(", ") : "(none)"}`,
		`- acceptance_criteria: ${context.acceptance.length > 0 ? context.acceptance.join(" | ") : "(none)"}`,
		`- implementation_surfaces: ${context.implementationSurfaces.length > 0 ? context.implementationSurfaces.join(" | ") : "(none)"}`,
		`- verification_commands: ${context.verificationCommands.length > 0 ? context.verificationCommands.join(" | ") : "(none)"}`,
		`- locked_notes: ${context.lockedNotes.length > 0 ? context.lockedNotes.join(" | ") : "(none)"}`,
		`- must_fix_findings: ${context.mustFixFindings.length > 0 ? context.mustFixFindings.join(" | ") : "(none)"}`,
		`- basis_commit: ${context.basisCommit ?? "(none)"}`,
		`- remaining_contract_ids_before: ${context.remainingBefore.length > 0 ? context.remainingBefore.join(", ") : "(none)"}`,
		`- release_blocker_count_before: ${context.releaseBlockerCountBefore ?? "(unknown)"}`,
		`- high_value_gap_count_before: ${context.highValueGapCountBefore ?? "(unknown)"}`,
		`- verification_evidence_path: ${evidence.path}`,
		`- verification_evidence_status: ${evidence.status}`,
		`- verification_evidence_subject_type: ${evidence.subjectType ?? "(missing)"}`,
		`- verification_evidence_slice_id: ${evidence.sliceId ?? "(none)"}`,
		`- verification_evidence_contract_ids: ${evidence.contractIds.length > 0 ? evidence.contractIds.join(", ") : "(none)"}`,
		`- verification_evidence_outcome: ${evidence.outcome ?? "(missing)"}`,
		`- verification_evidence_recorded_at: ${evidence.recordedAt ?? "(missing)"}`,
		`- verification_evidence_head_sha: ${evidence.headSha ?? "(missing)"}`,
		`- verification_evidence_basis_commit: ${evidence.basisCommit ?? "(missing)"}`,
		`- verification_evidence_commands: ${evidence.verificationCommands.length > 0 ? evidence.verificationCommands.join(" | ") : "(none)"}`,
		`- verification_evidence_summary: ${evidence.summary}`,
	];
}

export function buildEvaluationRoleReminderText(
	snapshot: CompletionStateSnapshot,
	role: string,
	deps: Parameters<typeof buildEvaluationRoleContextLines>[2],
): string {
	return buildEvaluationRoleContextLines(snapshot, role, deps).join(" ");
}

type CompletionHistoryCounts = {
	reviewed: number;
	audited: number;
	accepted: number;
	reopened: number;
	judgments: number;
};

type CompletionVerificationEvidenceSummary = {
	path: string;
	status: string;
	subjectType?: string;
	sliceId?: string;
	contractIds: string[];
	outcome?: string;
	recordedAt?: string;
	headSha?: string;
	basisCommit?: string;
	verificationCommands: string[];
	summary: string;
};

export function buildSystemReminder(args: {
	missionAnchor?: string;
	taskType?: string;
	evaluationProfile?: string;
	currentPhase?: string;
	continuationPolicy?: string;
	continuationReason?: string;
	nextMandatoryRole?: string;
	nextMandatoryAction?: string;
	remainingSliceCount: number | string;
	remainingStopJudges: number | string;
	history: CompletionHistoryCounts;
	exactActiveContract: boolean;
	activeContractDrift: string;
	activePriority?: number;
	activeWhyNow?: string;
	implementationSurfaces: string[];
	verificationCommands: string[];
	activePriorityLine?: string;
	activeWhyNowLine?: string;
	implementationSurfacesLine?: string;
	verificationCommandsLine?: string;
	evidence: CompletionVerificationEvidenceSummary;
	evaluationRoleReminderText?: string;
}): string {
	const lines = [
		"Completion workflow detected.",
		"Canonical truth lives in .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, .agent/stop-check-history.jsonl, and .agent/verification-evidence.json.",
		`Mission anchor: ${args.missionAnchor ?? "(unknown)"}`,
		`Task type: ${args.taskType ?? "(missing)"}`,
		`Evaluation profile: ${args.evaluationProfile ?? "(missing)"}`,
		`Current phase: ${args.currentPhase ?? "unknown"}`,
		`Continuation policy: ${args.continuationPolicy ?? "unknown"}`,
		`Continuation reason: ${args.continuationReason ?? "(unknown)"}`,
		`Next mandatory role: ${args.nextMandatoryRole ?? "unknown"}`,
		`Next mandatory action: ${args.nextMandatoryAction ?? "unknown"}`,
		`Remaining slice count: ${args.remainingSliceCount}`,
		`Remaining stop judges: ${args.remainingStopJudges}`,
		`History counts: reviewed=${args.history.reviewed}, audited=${args.history.audited}, accepted=${args.history.accepted}, reopened=${args.history.reopened}, judgments=${args.history.judgments}.`,
		"Re-read canonical .agent state after compaction or recovery instead of relying on conversation memory.",
		"If continuation_policy == continue, do not stop after a slice or ask whether to continue; dispatch the next mandatory role directly.",
		"Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.",
		"If canonical state is stale, invalid, ambiguous, or missing, route to completion-regrounder.",
		"When recovering from compaction, prefer a deterministic restart from canonical files over conversational inference.",
	];
	if (args.exactActiveContract) {
		lines.push("Selected/in-progress/committed/done .agent/active-slice.json is the canonical implementation contract.");
		lines.push(`Active slice contract drift: ${args.activeContractDrift}`);
	}
	if (args.activePriorityLine) lines.push(args.activePriorityLine);
	else if (args.activePriority !== undefined) lines.push(`Active slice priority: ${args.activePriority}`);
	if (args.activeWhyNowLine) lines.push(args.activeWhyNowLine);
	else if (args.activeWhyNow) lines.push(`Active slice why_now: ${args.activeWhyNow}`);
	if (args.implementationSurfacesLine) lines.push(args.implementationSurfacesLine);
	else if (args.implementationSurfaces.length > 0) lines.push(`Active implementation surfaces: ${args.implementationSurfaces.join(", ")}`);
	if (args.verificationCommandsLine) lines.push(args.verificationCommandsLine);
	else if (args.verificationCommands.length > 0) lines.push(`Active verification commands: ${args.verificationCommands.join(" | ")}`);
	lines.push(`Verification evidence artifact: ${args.evidence.path} (${args.evidence.status})`);
	if (args.evidence.subjectType) lines.push(`Verification evidence subject: ${args.evidence.subjectType}`);
	if (args.evidence.outcome) lines.push(`Verification evidence outcome: ${args.evidence.outcome}`);
	if (args.evidence.recordedAt) lines.push(`Verification evidence recorded_at: ${args.evidence.recordedAt}`);
	if (args.evidence.verificationCommands.length > 0) {
		lines.push(`Verification evidence commands: ${args.evidence.verificationCommands.join(" | ")}`);
	}
	lines.push(`Verification evidence summary: ${args.evidence.summary}`);
	if (args.evaluationRoleReminderText) lines.push(args.evaluationRoleReminderText);
	return lines.join(" ");
}

export function buildResumeCapsule(args: {
	missionAnchor?: string;
	taskType?: string;
	evaluationProfile?: string;
	currentPhase?: string;
	continuationPolicy?: string;
	continuationReason?: string;
	requiresReground: boolean | string;
	nextMandatoryRole?: string;
	nextMandatoryAction?: string;
	remainingSliceCount: number | string;
	remainingStopJudges: number | string;
	history: CompletionHistoryCounts;
	activeSliceMatchesPlan: "yes" | "no" | "unknown";
	activeSliceContractDrift: string;
	implementerHandoffSnapshot: "present" | "missing_or_unclear";
	evidence: CompletionVerificationEvidenceSummary;
	activeSlice: {
		sliceId?: string;
		status?: string;
		goal?: string;
		priority?: number;
		whyNow?: string;
		contractIds: string[];
		blockedOn: string[];
		lockedNotes: string[];
		mustFixFindings: string[];
		implementationSurfaces: string[];
		verificationCommands: string[];
		implementationSurfacesLine?: string;
		verificationCommandsLine?: string;
		basisCommit?: string;
		remainingContractIdsBefore: string[];
		releaseBlockerCountBefore?: number;
		highValueGapCountBefore?: number;
		acceptanceCriteria: string[];
	};
}): string {
	const lines = [
		"Authoritative completion resume capsule:",
		"",
		"<completion-state>",
		`mission_anchor: ${args.missionAnchor ?? "(unknown)"}`,
		`task_type: ${args.taskType ?? "(missing)"}`,
		`evaluation_profile: ${args.evaluationProfile ?? "(missing)"}`,
		`current_phase: ${args.currentPhase ?? "unknown"}`,
		`continuation_policy: ${args.continuationPolicy ?? "unknown"}`,
		`continuation_reason: ${args.continuationReason ?? "(unknown)"}`,
		`requires_reground: ${args.requiresReground}`,
		`next_mandatory_role: ${args.nextMandatoryRole ?? "unknown"}`,
		`next_mandatory_action: ${args.nextMandatoryAction ?? "unknown"}`,
		`remaining_slice_count: ${args.remainingSliceCount}`,
		`remaining_stop_judges: ${args.remainingStopJudges}`,
		`active_slice_matches_plan: ${args.activeSliceMatchesPlan}`,
		`active_slice_contract_drift_fields: ${args.activeSliceContractDrift}`,
		`implementer_handoff_snapshot: ${args.implementerHandoffSnapshot}`,
		`history_counts: reviewed=${args.history.reviewed}, audited=${args.history.audited}, accepted=${args.history.accepted}, reopened=${args.history.reopened}, judgments=${args.history.judgments}`,
		"",
		"verification_evidence:",
		`- path: ${args.evidence.path}`,
		`- status: ${args.evidence.status}`,
		`- subject_type: ${args.evidence.subjectType ?? "(missing)"}`,
		`- slice_id: ${args.evidence.sliceId ?? "(none)"}`,
		`- contract_ids: ${args.evidence.contractIds.length > 0 ? args.evidence.contractIds.join(", ") : "(none)"}`,
		`- outcome: ${args.evidence.outcome ?? "(missing)"}`,
		`- recorded_at: ${args.evidence.recordedAt ?? "(missing)"}`,
		`- head_sha: ${args.evidence.headSha ?? "(missing)"}`,
		`- basis_commit: ${args.evidence.basisCommit ?? "(missing)"}`,
		`- verification_commands: ${args.evidence.verificationCommands.length > 0 ? args.evidence.verificationCommands.join(" | ") : "(none)"}`,
		`- summary: ${args.evidence.summary}`,
		"",
		"active_slice:",
		`- slice_id: ${args.activeSlice.sliceId ?? "(none)"}`,
		`- status: ${args.activeSlice.status ?? "unknown"}`,
		`- goal: ${args.activeSlice.goal ?? "(unknown)"}`,
		`- priority: ${args.activeSlice.priority ?? "(unknown)"}`,
		`- why_now: ${args.activeSlice.whyNow ?? "(unknown)"}`,
		`- contract_ids: ${args.activeSlice.contractIds.length > 0 ? args.activeSlice.contractIds.join(", ") : "(none)"}`,
	];
	if (args.activeSlice.blockedOn.length > 0) lines.push(`- blocked_on: ${args.activeSlice.blockedOn.join(", ")}`);
	if (args.activeSlice.lockedNotes.length > 0) lines.push(`- locked_notes: ${args.activeSlice.lockedNotes.join(" | ")}`);
	if (args.activeSlice.mustFixFindings.length > 0) lines.push(`- must_fix_findings: ${args.activeSlice.mustFixFindings.join(" | ")}`);
	if (args.activeSlice.implementationSurfacesLine) {
		lines.push(args.activeSlice.implementationSurfacesLine);
	} else if (args.activeSlice.implementationSurfaces.length > 0) {
		lines.push(`- implementation_surfaces: ${args.activeSlice.implementationSurfaces.join(" | ")}`);
	}
	if (args.activeSlice.verificationCommandsLine) {
		lines.push(args.activeSlice.verificationCommandsLine);
	} else if (args.activeSlice.verificationCommands.length > 0) {
		lines.push(`- verification_commands: ${args.activeSlice.verificationCommands.join(" | ")}`);
	}
	lines.push(`- basis_commit: ${args.activeSlice.basisCommit ?? "(none)"}`);
	lines.push(`- remaining_contract_ids_before: ${args.activeSlice.remainingContractIdsBefore.length > 0 ? args.activeSlice.remainingContractIdsBefore.join(", ") : "(none)"}`);
	lines.push(`- release_blocker_count_before: ${args.activeSlice.releaseBlockerCountBefore ?? "(unknown)"}`);
	lines.push(`- high_value_gap_count_before: ${args.activeSlice.highValueGapCountBefore ?? "(unknown)"}`);
	lines.push("", "acceptance_criteria:");
	if (args.activeSlice.acceptanceCriteria.length === 0) lines.push("- (none)");
	else lines.push(...args.activeSlice.acceptanceCriteria.map((item) => `- ${item}`));
	lines.push(
		"",
		"Rules:",
		"- Treat this block as continuity support derived from canonical .agent state.",
		"- For selected/in-progress/committed/done slices, .agent/active-slice.json is the canonical implementation contract and the selected plan slice must mirror it exactly.",
		"- Preserve exact slice_id, goal, contract_ids, acceptance criteria, blocked_on, priority, why_now, implementation surfaces, verification commands, locked notes, must-fix findings, basis_commit, and before-slice counters where still true.",
		"- When populated, .agent/verification-evidence.json is the durable canonical verification record for the selected slice or current HEAD and should be consumed instead of temp-only artifacts or conversational summaries.",
		"- After compaction, re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, .agent/stop-check-history.jsonl, and .agent/verification-evidence.json before resuming long-running completion work.",
		"- Invoke completion-regrounder before continuing when requires_reground is true or unknown.",
		"- Invoke completion-regrounder before continuing when next_mandatory_role or next_mandatory_action is unknown or ambiguous.",
		"- Invoke completion-regrounder before continuing when active_slice_matches_plan is no, active_slice_contract_drift_fields is not none, or implementer_handoff_snapshot is missing_or_unclear.",
		"- If continuation_policy is continue, do not stop after a slice or ask whether to continue. Dispatch the next mandatory role directly.",
		"- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.",
		"- If you are completion-implementer after compaction, resume from the canonical active-slice implementation contract instead of asking the user to resend the original caller payload.",
		"- Do not replace canonical .agent state with summary inference.",
		"</completion-state>",
	);
	return lines.join("\n");
}
