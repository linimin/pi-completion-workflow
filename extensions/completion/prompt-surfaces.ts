import * as fs from "node:fs";
import * as path from "node:path";
import type { CompletionStateSnapshot, LiveRoleActivity } from "./types";
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
	if (lines.length === 0) {
		return "No critique, risk, or possible-noise notes were derived for this startup proposal.";
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

export function buildContextProposalConfirmationSelectItems(layout: ContextProposalConfirmationLayout) {
	return layout.actions.map((action) => ({
		value: action.id,
		label: action.label,
		description: action.description,
	}));
}

export function buildContextProposalAnalystPrompt(projectName: string, discussion: string): string {
	const lines = [`Project: ${projectName}`, "Infer the current mission from the discussion."];
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
