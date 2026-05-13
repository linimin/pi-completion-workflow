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
	buildContextProposalAnalystPromptFromEntries,
	deriveCookContextProposalFromRecentDiscussion,
	finalizeContextProposalAnalysis,
	normalizeProposalLine,
	parseContextProposalAnalystOutput as parseExtractedContextProposalAnalystOutput,
	resolveContextProposalConfirmationAction,
	shouldTreatBareActiveWorkflowProposalAsClearRefocus,
} from "./proposal";
import type {
	ContextProposal,
	ContextProposalAnalysis,
	ContextProposalConfirmAction,
	ContextProposalConfirmOptions,
	ContextProposalConfirmationLayout,
	ContextProposalDecision,
	RecentDiscussionEntry,
} from "./proposal";
import {
	buildContextProposalConfirmationLayout as buildExtractedContextProposalConfirmationLayout,
	buildContextProposalConfirmationSelectItems,
	buildContextProposalContinuationReason as buildExtractedContextProposalContinuationReason,
	buildEvaluationRoleContextLines as buildExtractedEvaluationRoleContextLines,
	buildEvaluationRoleReminderText as buildExtractedEvaluationRoleReminderText,
	contextProposalAnalystProgressLines as buildExtractedContextProposalAnalystProgressLines,
	maybeWriteContextProposalConfirmationSnapshot,
	maybeWriteContextProposalSnapshot,
} from "./prompt-surfaces";
import { toolCallBlockReason } from "./policy-guards";
import { getPiInvocation, runCompletionRole, writeTempFile } from "./role-runner";
import { refreshCompletionStatus } from "./status-surface";
import {
	buildProfileRecord,
	completionRootKey,
	defaultActiveSlice,
	defaultPlan,
	defaultState,
	defaultVerificationEvidence,
	detectDocsSurfaces,
	findCompletionRoot,
	findRepoRoot,
	loadCompletionDataForReminder,
	loadCompletionSnapshot,
	pathExists,
	readJson,
	readText,
	resolveFiles,
	writeJsonFile,
} from "./state-store";
import { parseFirstNumber, parseYesNo } from "./transcription";
import type { TranscriptionResult } from "./transcription";
import type { CompletionStateSnapshot, CompletionRole, JsonRecord, LiveRoleActivity } from "./types";

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

class StartupAnalystOverlay extends Container {
	private readonly border: DynamicBorder;
	private readonly title: Text;
	private readonly body: Text;
	private readonly footer: Text;
	private lines: string[] = [];
	onAbort?: () => void;

	constructor(private readonly theme: any) {
		super();
		this.border = new DynamicBorder((s: string) => this.theme.fg("accent", s));
		this.title = new Text("", 1, 0);
		this.body = new Text("", 1, 1);
		this.footer = new Text("", 1, 0);
		this.addChild(this.border);
		this.addChild(this.title);
		this.addChild(this.body);
		this.addChild(this.footer);
		this.updateDisplay();
	}

	setLines(lines: string[]): void {
		this.lines = [...lines];
		this.updateDisplay();
		this.invalidate();
	}

	private updateDisplay(): void {
		this.title.setText(this.theme.fg("accent", this.theme.bold("/cook proposal analyst")));
		this.body.setText(formatInlineRunningText(this.theme, this.lines, { primaryAssistant: true }));
		this.footer.setText(this.theme.fg("muted", "Esc/Ctrl+C cancel • This analysis runs before /cook writes canonical workflow state"));
	}

	override handleInput(data: string): void {
		if (data === "\u001b" || data === "\u0003") {
			this.onAbort?.();
			return;
		}
		// Container does not implement handleInput; ignore all other keys.
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}
}

const liveRoleActivityByRoot = new Map<string, LiveRoleActivity>();
const activatedCompletionRoutingRoots = new Set<string>();
const LIVE_ROLE_HEARTBEAT_MS = 5_000;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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

function candidateSlices(plan: JsonRecord | undefined): JsonRecord[] {
	const slices = plan?.candidate_slices;
	return Array.isArray(slices) ? slices.filter(isRecord) : [];
}

async function detectVerifierCommand(root: string): Promise<string | undefined> {
	const packageJsonPath = path.join(root, "package.json");
	const packageJson = await readJson(packageJsonPath);
	if (packageJson) {
		const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : undefined;
		const packageManager = asString((packageJson as JsonRecord).packageManager) ?? "";
		const runner = packageManager.startsWith("pnpm") ? "pnpm" : packageManager.startsWith("yarn") ? "yarn" : packageManager.startsWith("bun") ? "bun" : "npm";
		if (scripts && asString(scripts.test)) return runner === "npm" ? "npm test" : `${runner} test`;
		if (scripts && asString(scripts.check)) return runner === "npm" ? "npm run check" : `${runner} check`;
		if (scripts && asString(scripts.lint)) return runner === "npm" ? "npm run lint" : `${runner} lint`;
	}
	if (await pathExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm test";
	if (await pathExists(path.join(root, "bun.lockb")) || await pathExists(path.join(root, "bun.lock"))) return "bun test";
	if (await pathExists(path.join(root, "yarn.lock"))) return "yarn test";
	if (await pathExists(path.join(root, "Cargo.toml"))) return "cargo test";
	if (await pathExists(path.join(root, "pyproject.toml")) || await pathExists(path.join(root, "pytest.ini"))) return "pytest";
	if (await pathExists(path.join(root, "go.mod"))) return "go test ./...";
	if (await pathExists(path.join(root, "Makefile"))) return "make test";
	return undefined;
}

function normalizeMissionAnchorText(value: string): string {
	return value
		.replace(/^\/(?:cook|complete)\s+/i, "")
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/^\s*(please|pls|can you|could you|help me|i want to|we need to|let'?s|continue to|continue|resume)\s+/i, "")
		.replace(/\s+/g, " ")
		.replace(/[。！？.!?]+$/u, "")
		.trim();
}

function isWeakMissionAnchor(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (normalized.length < 8) return true;
	if (["continue", "resume", "fix", "fix it", "work on this", "help", "do it", "try again"].includes(normalized)) return true;
	if (/^(continue|resume|fix|help|work on)(\s+.*)?$/i.test(normalized) && normalized.split(/\s+/).length <= 3) return true;
	return false;
}

type MissionAnchorAssessment = {
	derived: string;
};

function assessMissionAnchor(rawGoal: string, projectName: string): MissionAnchorAssessment {
	return { derived: deriveMissionAnchor(rawGoal, projectName) };
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
	"/cook only supports the bare /cook entrypoint. Move mission text into the main chat, then rerun /cook.";
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

function shouldInjectCompletionWorkflowContext(snapshot: CompletionStateSnapshot | undefined): boolean {
	return hasCompletionRoutingActivation(snapshot);
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

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!isRecord(item)) return "";
			if (item.type !== "text") return "";
			return asString(item.text) ?? "";
		})
		.filter((item) => item.length > 0)
		.join("\n")
		.trim();
}

function stripCodeBlocks(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ");
}

const MISSION_SCOPE_FILTER_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"goal",
	"goals",
	"in",
	"into",
	"is",
	"it",
	"its",
	"mission",
	"of",
	"on",
	"or",
	"scope",
	"that",
	"the",
	"their",
	"this",
	"to",
	"using",
	"with",
	"workflow",
]);

function missionScopeFilterTokens(text: string): string[] {
	const normalized = normalizeProposalLine(text).toLowerCase();
	const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
	return tokens.filter((token) => {
		if (/^[\p{Script=Han}]+$/u.test(token)) return token.length >= 2;
		if (token.length < 2) return false;
		return !MISSION_SCOPE_FILTER_STOPWORDS.has(token);
	});
}

function isSessionScopeItemMissionRelevant(item: string, mission: string): boolean {
	const normalizedItem = normalizeProposalLine(item).toLowerCase();
	const normalizedMission = normalizeMissionAnchorText(mission).toLowerCase();
	if (!normalizedItem || !normalizedMission) return true;
	if (normalizedItem.includes(normalizedMission) || normalizedMission.includes(normalizedItem)) return true;
	const itemTokens = [...new Set(missionScopeFilterTokens(normalizedItem))];
	const missionTokens = new Set(missionScopeFilterTokens(normalizedMission));
	if (itemTokens.length === 0 || missionTokens.size === 0) return true;
	const overlap = itemTokens.filter((token) => missionTokens.has(token));
	if (overlap.length >= 2) return true;
	return overlap.some((token) => token.length >= 6 || /[\p{Script=Han}]/u.test(token));
}

function missionAnchorSemanticTokens(text: string): string[] {
	return [...new Set(missionScopeFilterTokens(normalizeMissionAnchorText(text).toLowerCase()))];
}

function missionAnchorOrderedTokenOverlapRatio(leftTokens: string[], rightTokens: string[]): number {
	if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
	const dp = new Array(rightTokens.length + 1).fill(0);
	for (const leftToken of leftTokens) {
		let previous = 0;
		for (let index = 0; index < rightTokens.length; index += 1) {
			const nextPrevious = dp[index + 1];
			if (leftToken === rightTokens[index]) {
				dp[index + 1] = previous + 1;
			} else {
				dp[index + 1] = Math.max(dp[index + 1], dp[index]);
			}
			previous = nextPrevious;
		}
	}
	return dp[rightTokens.length] / Math.max(leftTokens.length, rightTokens.length);
}

function missionAnchorBigramOverlapRatio(leftTokens: string[], rightTokens: string[]): number {
	if (leftTokens.length < 2 || rightTokens.length < 2) return 0;
	const leftBigrams = new Set(leftTokens.slice(0, -1).map((token, index) => `${token} ${leftTokens[index + 1]}`));
	const rightBigrams = new Set(rightTokens.slice(0, -1).map((token, index) => `${token} ${rightTokens[index + 1]}`));
	if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;
	let overlap = 0;
	for (const bigram of leftBigrams) {
		if (rightBigrams.has(bigram)) overlap += 1;
	}
	return overlap / Math.max(leftBigrams.size, rightBigrams.size);
}

function missionAnchorsStrictlyEquivalent(left: string, right: string): boolean {
	return normalizeMissionAnchorText(left).toLowerCase() === normalizeMissionAnchorText(right).toLowerCase();
}

const MISSION_NEGATION_CUE_REGEX = /(?:^|[^\p{L}\p{N}_])(?:no|not|without|never|cannot|don['’]?t)(?=$|[^\p{L}\p{N}_])/u;

function missionAnchorHasNegationCue(text: string): boolean {
	return MISSION_NEGATION_CUE_REGEX.test(text);
}

function missionAnchorsLikelyEquivalent(left: string, right: string): boolean {
	const normalizedLeft = normalizeMissionAnchorText(left).toLowerCase();
	const normalizedRight = normalizeMissionAnchorText(right).toLowerCase();
	if (!normalizedLeft || !normalizedRight) return false;
	const leftHasNegationCue = missionAnchorHasNegationCue(normalizedLeft);
	const rightHasNegationCue = missionAnchorHasNegationCue(normalizedRight);
	if (leftHasNegationCue !== rightHasNegationCue) return false;
	if (normalizedLeft === normalizedRight) return true;
	if (!leftHasNegationCue && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))) return true;
	const leftTokens = missionAnchorSemanticTokens(normalizedLeft);
	const rightTokens = missionAnchorSemanticTokens(normalizedRight);
	if (leftTokens.length === 0 || rightTokens.length === 0) return false;
	const rightSet = new Set(rightTokens);
	const overlap = leftTokens.filter((token) => rightSet.has(token));
	if (overlap.length < 3) return false;
	const maxLen = Math.max(leftTokens.length, rightTokens.length);
	if (overlap.length / maxLen < 0.75) return false;
	if (missionAnchorOrderedTokenOverlapRatio(leftTokens, rightTokens) < 0.75) return false;
	if (Math.min(leftTokens.length, rightTokens.length) < 4) return true;
	return missionAnchorBigramOverlapRatio(leftTokens, rightTokens) >= 0.5;
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
				scope: assessment.proposal?.scope ?? [],
				constraints: assessment.proposal?.constraints ?? [],
				acceptance: assessment.proposal?.acceptance ?? [],
			},
			null,
			2,
		)}\n`,
	);
}

const CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT = [
	"You analyze recent /cook startup discussion and return a strict JSON object.",
	"Do not emit markdown, code fences, or commentary.",
	"Return exactly one JSON object with keys: mission, scope, constraints, acceptance, critique, risks, task_type, evaluation_profile, confidence, possible_noise.",
	"mission must be a concise implementation mission anchor sentence.",
	"scope must contain only work items that directly support the mission.",
	"constraints must contain guardrails or non-goals explicitly stated or strongly implied by the discussion.",
	"acceptance must contain verifiable outcomes explicitly stated or strongly implied by the discussion.",
	"critique must contain operator-facing cautions, concerns, or reminders that should be shown separately from mission and scope later.",
	"risks must contain concrete failure modes or regressions that the later workflow should keep in view.",
	"task_type and evaluation_profile should be candidate routing hints only; reuse the existing completion vocabulary when it clearly fits instead of inventing new schema names.",
	"possible_noise should list discussion points that look stale, weakly related, or unsafe to promote into scope.",
	"When discussion is insufficient, prefer empty arrays and a low confidence value over invention.",
].join(" ");

function collectRecentDiscussionEntries(ctx: { sessionManager: any }, limit = 8): RecentDiscussionEntry[] {
	let branch: any[] = [];
	try {
		branch = ctx.sessionManager?.getBranch?.() ?? [];
	} catch (error) {
		if (isStaleContextError(error)) return [];
		throw error;
	}
	const entries: RecentDiscussionEntry[] = [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message as JsonRecord;
		let text = "";
		let role: RecentDiscussionEntry["role"] | undefined;
		const messageRole = asString(message.role);
		if (messageRole === "user" || messageRole === "custom") {
			text = extractTextFromMessageContent(message.content);
			role = messageRole;
		}
		if (!text || !role) continue;
		const trimmed = text.trim();
		if (!trimmed || /^\/(?:cook|complete)\b/i.test(trimmed)) continue;
		entries.push({ role, text: trimmed });
		if (entries.length >= limit) break;
	}
	return entries;
}

function serializeRecentDiscussionEntries(entries: RecentDiscussionEntry[]): string {
	return entries
		.slice()
		.reverse()
		.map((entry, index) => `[${index + 1}] ${entry.role.toUpperCase()}\n${entry.text}`)
		.join("\n\n");
}

function extractJsonObjectFromText(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	if (unfenced.startsWith("{") && unfenced.endsWith("}")) return unfenced;
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	return unfenced.slice(start, end + 1);
}

function parseContextProposalAnalystOutput(raw: string, projectName: string): ContextProposal | undefined {
	return parseExtractedContextProposalAnalystOutput(raw, projectName, {
		extractJsonObjectFromText,
		isRecord,
		asString,
		asStringArray,
		assessMissionAnchor,
		normalizeMissionAnchorText,
		isWeakMissionAnchor,
		missionAnchorsStrictlyEquivalent,
	});
}

function contextProposalAnalystModelArg(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const provider = asString(model.provider);
	const id = asString(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

function buildContextProposalAnalystPrompt(projectName: string, recentEntries: RecentDiscussionEntry[]): string {
	return buildContextProposalAnalystPromptFromEntries(projectName, recentEntries, serializeRecentDiscussionEntries);
}

function contextProposalAnalystProgressLines(activity: LiveRoleActivity): string[] {
	return buildExtractedContextProposalAnalystProgressLines(activity, buildInlineRunningLines);
}

async function runContextProposalAnalystSubprocess(
	ctx: { cwd: string; hasUI: boolean; ui: any; model?: any },
	projectName: string,
	recentEntries: RecentDiscussionEntry[],
): Promise<string | undefined> {
	const modelArg = contextProposalAnalystModelArg(ctx.model);
	if (!modelArg) return undefined;
	const cwd = getCtxCwd(ctx);
	const runCwd = findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? cwd;
	const rootKey = completionRootKey(undefined, cwd);
	const prompt = buildContextProposalAnalystPrompt(projectName, recentEntries);
	const systemPromptTemp = await writeTempFile(runCwd, "pi-cook-proposal-analyst-", CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT);
	const analystRole = "cook-proposal-analyst";
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPromptTemp.filePath, "--model", modelArg, prompt];
	const invocation = getPiInvocation(args);
	const liveActivity = createLiveRoleActivity(analystRole);
	liveActivity.progress = "Analyzing recent discussion";
	liveActivity.currentAction = "Reading recent discussion and preparing a startup proposal";
	liveActivity.assistantSummary = liveActivity.progress;
	liveActivity.recentActivity = pushRecentActivity(liveActivity.recentActivity, `assistant: ${liveActivity.progress}`);
	const messages: RoleMessage[] = [];
	let stderr = "";
	let overlay: StartupAnalystOverlay | undefined;
	let finishOverlay: ((value: string | undefined) => void) | undefined;
	let overlaySettled = false;
	const settleOverlay = (value: string | undefined) => {
		if (overlaySettled) return;
		overlaySettled = true;
		finishOverlay?.(value);
	};
	const updateActivity = (fresh = false) => {
		if (fresh) liveActivity.updatedAt = nowMs();
		liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: "running" }));
		void refreshCompletionStatus({
			ctx,
			liveRoleActivityByRoot,
			completionStatusKey: COMPLETION_STATUS_KEY,
			safeUiCall,
			getCtxCwd,
			getCtxHasUI,
			getCtxUi,
		});
		overlay?.setLines(contextProposalAnalystProgressLines(liveActivity));
	};
	const heartbeat = setInterval(() => updateActivity(false), LIVE_ROLE_HEARTBEAT_MS);
	const run = async (): Promise<string | undefined> => {
		try {
			updateActivity(true);
			const output = await new Promise<string | undefined>((resolve) => {
				const proc = spawn(invocation.command, invocation.args, {
					cwd: runCwd,
					env: process.env,
					stdio: ["ignore", "pipe", "pipe"],
					shell: false,
				});
				let settled = false;
				const resolveOnce = (value: string | undefined) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				const abort = () => {
					proc.kill("SIGTERM");
					resolveOnce(undefined);
				};
				const handleSigint = () => abort();
				let buffer = "";
				const processLine = (line: string) => {
					if (!line.trim()) return;
					try {
						const event = JSON.parse(line) as JsonRecord;
						if (applyLiveRoleEvent(liveActivity, event, messages)) updateActivity(true);
					} catch {
						// ignore malformed lines
					}
				};
				proc.stdout.on("data", (chunk) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) processLine(line);
				});
				proc.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				proc.on("close", (code) => {
					process.off("SIGINT", handleSigint);
					if (buffer.trim()) processLine(buffer);
					resolveOnce(code === 0 ? liveActivity.lastAssistantText?.trim() || undefined : undefined);
				});
				proc.on("error", () => {
					process.off("SIGINT", handleSigint);
					resolveOnce(undefined);
				});
				process.once("SIGINT", handleSigint);
				if (overlay) {
					overlay.onAbort = () => {
						process.off("SIGINT", handleSigint);
						abort();
					};
				}
			});
			liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: output ? "ok" : "error" }));
			await refreshCompletionStatus({
				ctx,
				liveRoleActivityByRoot,
				completionStatusKey: COMPLETION_STATUS_KEY,
				safeUiCall,
				getCtxCwd,
				getCtxHasUI,
				getCtxUi,
			});
			return output;
		} finally {
			clearInterval(heartbeat);
			setTimeout(() => {
				const current = liveRoleActivityByRoot.get(rootKey);
				if (current && current.role === analystRole && current.status !== "running") {
					liveRoleActivityByRoot.delete(rootKey);
					void refreshCompletionStatus({
						ctx,
						liveRoleActivityByRoot,
						completionStatusKey: COMPLETION_STATUS_KEY,
						safeUiCall,
						getCtxCwd,
						getCtxHasUI,
						getCtxUi,
					});
				}
			}, 10_000);
			await fsp.rm(systemPromptTemp.dir, { recursive: true, force: true });
		}
	};
	if (getCtxHasUI(ctx)) {
		const ui = getCtxUi(ctx);
		if (ui) {
			return await ui.custom<string | undefined>((_tui, theme, _kb, done) => {
				finishOverlay = done;
				overlay = new StartupAnalystOverlay(theme);
				overlay.setLines(contextProposalAnalystProgressLines(liveActivity));
				run().then(settleOverlay).catch(() => settleOverlay(undefined));
				return overlay;
			});
		}
	}
	return await run();
}

async function analyzeContextProposalWithAgent(
	ctx: { cwd: string; hasUI: boolean; ui: any; model?: any; modelRegistry?: any },
	projectName: string,
	recentEntries: RecentDiscussionEntry[],
): Promise<ContextProposal | undefined> {
	if (shouldDisableContextProposalAnalyst()) return undefined;
	const testOutput = completionTestContextProposalAnalystOutput();
	if (testOutput) {
		return parseContextProposalAnalystOutput(testOutput, projectName);
	}
	if (recentEntries.length === 0) return undefined;
	try {
		const raw = await runContextProposalAnalystSubprocess(ctx, projectName, recentEntries);
		if (!raw) return undefined;
		return parseContextProposalAnalystOutput(raw, projectName);
	} catch (error) {
		console.warn("[completion] context proposal analyst failed", error);
		return undefined;
	}
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
): Promise<ContextProposal | undefined> {
	const recentEntries = collectRecentDiscussionEntries(ctx);
	return await deriveCookContextProposalFromRecentDiscussion(projectName, recentEntries, {
		asString,
		asStringArray,
		analyzeContextProposal: async (entries) => await analyzeContextProposalWithAgent(ctx, projectName, entries),
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

function deriveMissionAnchor(rawGoal: string, projectName: string): string {
	const normalized = normalizeMissionAnchorText(rawGoal);
	if (!normalized || isWeakMissionAnchor(normalized)) {
		return `Drive ${projectName} to truthful, verifiable completion.`;
	}

	let mission = normalized
		.replace(/\b(end[- ]to[- ]end|for me|thanks|thank you)\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();

	mission = mission
		.replace(/\bwith tests and docs\b/gi, "with tests and docs parity")
		.replace(/\bwith tests and documentation\b/gi, "with tests and docs parity")
		.replace(/\bwith docs\b/gi, "with docs parity")
		.trim();

	if (!/[.!?。！？]$/u.test(mission)) mission += ".";
	return mission;
}


function buildAgentReadme(projectName: string): string {
	return `# Completion Control Plane\n\nThis repository uses the \`completion\` workflow for long-running coding tasks.\n\n## Canonical tracked contract files\n\n- \`.agent/README.md\`\n- \`.agent/mission.md\`\n- \`.agent/profile.json\`\n- \`.agent/verify_completion_stop.sh\`\n- \`.agent/verify_completion_control_plane.sh\`\n\n## Ignored canonical execution state\n\n- \`.agent/state.json\`\n- \`.agent/plan.json\`\n- \`.agent/active-slice.json\`\n- \`.agent/slice-history.jsonl\`\n- \`.agent/stop-check-history.jsonl\`\n- \`.agent/verification-evidence.json\`\n- \`.agent/*.log\`\n- \`.agent/tmp/\`\n\n\`.agent/verification-evidence.json\` is the durable canonical record of deterministic verification for the selected slice or current HEAD. Recovery, review, audit, and stop-check reminder surfaces consume it instead of temp-only artifacts or conversational summaries when it is populated.\n\nThe source of truth for long-running completion work is canonical \`.agent/**\` state plus current repo truth.\n\nProject: ${projectName}\n`;
}

function buildMission(projectName: string, missionAnchor: string): string {
	return `# Mission\n\nProject: ${projectName}\n\nMission anchor:\n${missionAnchor}\n\nThis file is a tracked human-readable statement of the repo's completion mission. Re-grounders may refine this file when repo truth becomes clearer, but it must stay truthful to shipped behavior and the active completion objective.\n`;
}

function buildVerifyStopScript(verifierCommand?: string): string {
	const repoCheck = verifierCommand
		? `echo "[completion] running repo-level verification: ${verifierCommand}"\n${verifierCommand}`
		: `echo "[completion] no repo-specific verifier auto-detected; control-plane verification only"`;
	return `#!/usr/bin/env bash\nset -euo pipefail\n\nbash .agent/verify_completion_control_plane.sh\n${repoCheck}\n`;
}

function buildVerifyControlPlaneScript(): string {
	return `#!/usr/bin/env bash
set -euo pipefail

for file in \
  .agent/README.md \
  .agent/mission.md \
  .agent/profile.json \
  .agent/verify_completion_stop.sh \
  .agent/verify_completion_control_plane.sh \
  .agent/state.json \
  .agent/plan.json \
  .agent/active-slice.json \
  .agent/verification-evidence.json; do
  [[ -e "$file" ]] || { echo "missing required file: $file"; exit 1; }
done

node <<'NODE'
const childProcess = require('node:child_process');
const fs = require('node:fs');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
const isNonEmptyString = (value) => isString(value) && value.length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const hasOnlyKeys = (object, allowed, label) => {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  assert(unknown.length === 0, label + ': unknown keys: ' + unknown.join(', '));
};
const requireKeys = (object, required, label) => {
  for (const key of required) {
    assert(Object.prototype.hasOwnProperty.call(object, key), label + ': missing required field: ' + key);
  }
};
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sameStringArrays = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

for (const file of ['.agent/profile.json', '.agent/state.json', '.agent/plan.json', '.agent/active-slice.json', '.agent/verification-evidence.json']) {
  readJson(file);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');
const evidence = readJson('.agent/verification-evidence.json');

assert(isObject(profile), '.agent/profile.json must be an object');
assert(isObject(state), '.agent/state.json must be an object');
assert(isObject(plan), '.agent/plan.json must be an object');
assert(isObject(active), '.agent/active-slice.json must be an object');
assert(isObject(evidence), '.agent/verification-evidence.json must be an object');

const requiredProfile = ['schema_version', 'protocol_id', 'project_name', 'required_stop_judges', 'priority_policy_id', 'task_type', 'evaluation_profile', 'docs_surfaces'];
requireKeys(profile, requiredProfile, '.agent/profile.json');
hasOnlyKeys(profile, requiredProfile, '.agent/profile.json');
assert(profile.protocol_id === 'completion', '.agent/profile.json: protocol_id must be completion');
assert(Array.isArray(profile.docs_surfaces), '.agent/profile.json: docs_surfaces must be an array');
assert(isNonEmptyString(profile.task_type), '.agent/profile.json: task_type must be a non-empty string');
assert(isNonEmptyString(profile.evaluation_profile), '.agent/profile.json: evaluation_profile must be a non-empty string');

const requiredState = [
  'schema_version','mission_anchor','task_type','evaluation_profile','current_phase','continuation_policy','continuation_reason','project_done',
  'requires_reground','slices_since_last_reground','remaining_release_blockers','remaining_high_value_gaps',
  'unsatisfied_contract_ids','release_blocker_ids','next_mandatory_action','next_mandatory_role',
  'remaining_stop_judges','last_reground_at','last_auditor_verdict','contract_status','latest_completed_slice','latest_verified_slice'
];
const continuationPolicies = ['continue', 'await_user_input', 'blocked', 'paused', 'done'];
const workflowRoles = ['completion-bootstrapper', 'completion-regrounder', 'completion-implementer', 'completion-reviewer', 'completion-auditor', 'completion-stop-judge', null];
const workflowPhases = ['reground', 'implement', 'post_commit_review', 'post_commit_audit', 'post_commit_reconcile', 'stop_wave', 'awaiting_user', 'blocked', 'done'];
requireKeys(state, requiredState, '.agent/state.json');
hasOnlyKeys(state, requiredState, '.agent/state.json');
assert(continuationPolicies.includes(state.continuation_policy), '.agent/state.json: invalid continuation_policy');
assert(workflowRoles.includes(state.next_mandatory_role), '.agent/state.json: invalid next_mandatory_role');
assert(workflowPhases.includes(state.current_phase), '.agent/state.json: invalid current_phase');
assert(isNonEmptyString(state.task_type), '.agent/state.json: task_type must be a non-empty string');
assert(isNonEmptyString(state.evaluation_profile), '.agent/state.json: evaluation_profile must be a non-empty string');
assert(isStringArray(state.unsatisfied_contract_ids), '.agent/state.json: unsatisfied_contract_ids must be an array of strings');
assert(isStringArray(state.release_blocker_ids), '.agent/state.json: release_blocker_ids must be an array of strings');

const requiredPlan = ['schema_version', 'mission_anchor', 'task_type', 'evaluation_profile', 'last_reground_at', 'plan_basis', 'candidate_slices'];
const requiredSlice = ['slice_id', 'goal', 'acceptance_criteria', 'contract_ids', 'priority', 'status', 'why_now', 'blocked_on', 'evidence'];
const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
const allowedSlice = [...requiredSlice, ...planMirrorFields];
const sliceStatuses = ['planned', 'selected', 'in_progress', 'blocked', 'done', 'cancelled'];
requireKeys(plan, requiredPlan, '.agent/plan.json');
hasOnlyKeys(plan, requiredPlan, '.agent/plan.json');
assert(isNonEmptyString(plan.task_type), '.agent/plan.json: task_type must be a non-empty string');
assert(isNonEmptyString(plan.evaluation_profile), '.agent/plan.json: evaluation_profile must be a non-empty string');
assert(Array.isArray(plan.candidate_slices), '.agent/plan.json: candidate_slices must be an array');
for (const [index, slice] of plan.candidate_slices.entries()) {
  const label = '.agent/plan.json candidate_slices[' + index + ']';
  assert(isObject(slice), label + ' must be an object');
  requireKeys(slice, requiredSlice, label);
  hasOnlyKeys(slice, allowedSlice, label);
  assert(isString(slice.slice_id) && slice.slice_id.length > 0, label + ': slice_id must be a non-empty string');
  assert(isString(slice.goal) && slice.goal.length > 0, label + ': goal must be a non-empty string');
  assert(Array.isArray(slice.acceptance_criteria) && slice.acceptance_criteria.length > 0 && slice.acceptance_criteria.every((item) => typeof item === 'string' && item.length > 0), label + ': acceptance_criteria must be a non-empty array of strings');
  assert(isStringArray(slice.contract_ids), label + ': contract_ids must be an array of strings');
  assert(typeof slice.priority === 'number' && Number.isFinite(slice.priority), label + ': priority must be a finite number');
  assert(sliceStatuses.includes(slice.status), label + ': invalid status');
  assert(isString(slice.why_now) && slice.why_now.length > 0, label + ': why_now must be a non-empty string');
  assert(isStringArray(slice.blocked_on), label + ': blocked_on must be an array of strings');
  assert(isStringArray(slice.evidence), label + ': evidence must be an array of strings');
  if (hasOwn(slice, 'locked_notes')) assert(isStringArray(slice.locked_notes), label + ': locked_notes must be an array of strings when present');
  if (hasOwn(slice, 'must_fix_findings')) assert(isStringArray(slice.must_fix_findings), label + ': must_fix_findings must be an array of strings when present');
  if (hasOwn(slice, 'implementation_surfaces')) assert(isStringArray(slice.implementation_surfaces), label + ': implementation_surfaces must be an array of strings when present');
  if (hasOwn(slice, 'verification_commands')) assert(isStringArray(slice.verification_commands), label + ': verification_commands must be an array of strings when present');
  if (hasOwn(slice, 'basis_commit')) assert(isNonEmptyString(slice.basis_commit), label + ': basis_commit must be a non-empty string when present');
  if (hasOwn(slice, 'remaining_contract_ids_before')) assert(isStringArray(slice.remaining_contract_ids_before), label + ': remaining_contract_ids_before must be an array of strings when present');
  if (hasOwn(slice, 'release_blocker_count_before')) assert(typeof slice.release_blocker_count_before === 'number' && Number.isFinite(slice.release_blocker_count_before), label + ': release_blocker_count_before must be a finite number when present');
  if (hasOwn(slice, 'high_value_gap_count_before')) assert(typeof slice.high_value_gap_count_before === 'number' && Number.isFinite(slice.high_value_gap_count_before), label + ': high_value_gap_count_before must be a finite number when present');
}

const isNonEmptyStringArray = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => isNonEmptyString(item));
const requiredActiveBase = ['schema_version', 'mission_anchor', 'task_type', 'evaluation_profile', 'status', 'slice_id', 'goal', 'contract_ids', 'acceptance_criteria', 'blocked_on', 'locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
const allowedActive = [...requiredActiveBase, 'priority', 'why_now'];
const activeStatuses = ['idle', 'selected', 'in_progress', 'committed', 'done'];
requireKeys(active, requiredActiveBase, '.agent/active-slice.json');
hasOnlyKeys(active, allowedActive, '.agent/active-slice.json');
assert(activeStatuses.includes(active.status), '.agent/active-slice.json: invalid status');
assert(isNonEmptyString(active.task_type), '.agent/active-slice.json: task_type must be a non-empty string');
assert(isNonEmptyString(active.evaluation_profile), '.agent/active-slice.json: evaluation_profile must be a non-empty string');
assert(isStringArray(active.contract_ids), '.agent/active-slice.json: contract_ids must be an array of strings');
assert(Array.isArray(active.acceptance_criteria), '.agent/active-slice.json: acceptance_criteria must be an array');
assert(isStringArray(active.blocked_on), '.agent/active-slice.json: blocked_on must be an array of strings');
assert(isStringArray(active.locked_notes), '.agent/active-slice.json: locked_notes must be an array of strings');
assert(isStringArray(active.must_fix_findings), '.agent/active-slice.json: must_fix_findings must be an array of strings');
assert(isStringArray(active.implementation_surfaces), '.agent/active-slice.json: implementation_surfaces must be an array of strings');
assert(isStringArray(active.verification_commands), '.agent/active-slice.json: verification_commands must be an array of strings');
assert(isStringArray(active.remaining_contract_ids_before), '.agent/active-slice.json: remaining_contract_ids_before must be an array of strings');

const requiredEvidence = ['schema_version', 'artifact_type', 'subject_type', 'slice_id', 'goal', 'contract_ids', 'basis_commit', 'head_sha', 'verification_commands', 'outcome', 'recorded_at', 'summary'];
const evidenceSubjectTypes = ['none', 'selected_slice', 'current_head'];
const evidenceOutcomes = ['not_recorded', 'passed', 'failed'];
requireKeys(evidence, requiredEvidence, '.agent/verification-evidence.json');
hasOnlyKeys(evidence, requiredEvidence, '.agent/verification-evidence.json');
assert(evidence.artifact_type === 'completion-verification-evidence', '.agent/verification-evidence.json: artifact_type must be completion-verification-evidence');
assert(evidenceSubjectTypes.includes(evidence.subject_type), '.agent/verification-evidence.json: invalid subject_type');
assert(evidence.slice_id === null || isNonEmptyString(evidence.slice_id), '.agent/verification-evidence.json: slice_id must be null or a non-empty string');
assert(evidence.goal === null || isNonEmptyString(evidence.goal), '.agent/verification-evidence.json: goal must be null or a non-empty string');
assert(isStringArray(evidence.contract_ids), '.agent/verification-evidence.json: contract_ids must be an array of strings');
assert(evidence.basis_commit === null || isNonEmptyString(evidence.basis_commit), '.agent/verification-evidence.json: basis_commit must be null or a non-empty string');
assert(evidence.head_sha === null || isNonEmptyString(evidence.head_sha), '.agent/verification-evidence.json: head_sha must be null or a non-empty string');
assert(isStringArray(evidence.verification_commands), '.agent/verification-evidence.json: verification_commands must be an array of strings');
assert(evidenceOutcomes.includes(evidence.outcome), '.agent/verification-evidence.json: invalid outcome');
assert(evidence.recorded_at === null || (isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at))), '.agent/verification-evidence.json: recorded_at must be null or an ISO-8601 string');
assert(isNonEmptyString(evidence.summary), '.agent/verification-evidence.json: summary must be a non-empty string');

assert(state.task_type === profile.task_type, '.agent/state.json: task_type must match .agent/profile.json');
assert(plan.task_type === profile.task_type, '.agent/plan.json: task_type must match .agent/profile.json');
assert(active.task_type === profile.task_type, '.agent/active-slice.json: task_type must match .agent/profile.json');
assert(state.evaluation_profile === profile.evaluation_profile, '.agent/state.json: evaluation_profile must match .agent/profile.json');
assert(plan.evaluation_profile === profile.evaluation_profile, '.agent/plan.json: evaluation_profile must match .agent/profile.json');
assert(active.evaluation_profile === profile.evaluation_profile, '.agent/active-slice.json: evaluation_profile must match .agent/profile.json');

const requiresExactHandoff = ['selected', 'in_progress', 'committed', 'done'].includes(active.status);
if (requiresExactHandoff) {
  assert(isNonEmptyStringArray(active.acceptance_criteria), '.agent/active-slice.json: acceptance_criteria must be a non-empty array of strings when status carries an exact handoff');
  assert(typeof active.priority === 'number' && Number.isFinite(active.priority), '.agent/active-slice.json: priority must be a finite number when status carries an exact handoff');
  assert(isString(active.why_now) && active.why_now.length > 0, '.agent/active-slice.json: why_now must be a non-empty string when status carries an exact handoff');
  assert(isNonEmptyStringArray(active.implementation_surfaces), '.agent/active-slice.json: implementation_surfaces must be a non-empty array of strings when status carries an exact handoff');
  assert(isNonEmptyStringArray(active.verification_commands), '.agent/active-slice.json: verification_commands must be a non-empty array of strings when status carries an exact handoff');
  assert(isString(active.basis_commit) && active.basis_commit.length > 0, '.agent/active-slice.json: basis_commit must be a non-empty string when status carries an exact handoff');
  assert(typeof active.release_blocker_count_before === 'number' && Number.isFinite(active.release_blocker_count_before), '.agent/active-slice.json: release_blocker_count_before must be a finite number when status carries an exact handoff');
  assert(typeof active.high_value_gap_count_before === 'number' && Number.isFinite(active.high_value_gap_count_before), '.agent/active-slice.json: high_value_gap_count_before must be a finite number when status carries an exact handoff');

  const planSlice = plan.candidate_slices.find((slice) => isObject(slice) && slice.slice_id === active.slice_id);
  assert(isObject(planSlice), '.agent/active-slice.json: slice_id must match a slice in .agent/plan.json when status carries an exact handoff');
  const drift = [];
  if (planSlice.goal !== active.goal) drift.push('goal');
  if (!sameStringArrays(planSlice.contract_ids, active.contract_ids)) drift.push('contract_ids');
  if (!sameStringArrays(planSlice.acceptance_criteria, active.acceptance_criteria)) drift.push('acceptance_criteria');
  if (!sameStringArrays(planSlice.blocked_on, active.blocked_on)) drift.push('blocked_on');
  if (planSlice.priority !== active.priority) drift.push('priority');
  if (planSlice.why_now !== active.why_now) drift.push('why_now');

  const expectPlanArrayMirror = (field) => {
    if (!hasOwn(planSlice, field) || !sameStringArrays(planSlice[field], active[field])) drift.push(field);
  };
  const expectPlanStringMirror = (field) => {
    if (!hasOwn(planSlice, field) || planSlice[field] !== active[field]) drift.push(field);
  };
  const expectPlanNumberMirror = (field) => {
    if (!hasOwn(planSlice, field) || planSlice[field] !== active[field]) drift.push(field);
  };

  expectPlanArrayMirror('implementation_surfaces');
  expectPlanArrayMirror('verification_commands');
  expectPlanArrayMirror('locked_notes');
  expectPlanArrayMirror('must_fix_findings');
  expectPlanStringMirror('basis_commit');
  expectPlanArrayMirror('remaining_contract_ids_before');
  expectPlanNumberMirror('release_blocker_count_before');
  expectPlanNumberMirror('high_value_gap_count_before');
  assert(drift.length === 0, '.agent/active-slice.json must match the selected .agent/plan.json slice across: ' + Array.from(new Set(drift)).join(', '));
}

const currentHead = (() => {
  try {
    return childProcess.execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
})();

if (requiresExactHandoff) {
  assert(evidence.subject_type === 'selected_slice', '.agent/verification-evidence.json: subject_type must be selected_slice when active slice exact handoff requires verification evidence');
  assert(evidence.slice_id === active.slice_id, '.agent/verification-evidence.json: slice_id must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.goal === active.goal, '.agent/verification-evidence.json: goal must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(sameStringArrays(evidence.contract_ids, active.contract_ids), '.agent/verification-evidence.json: contract_ids must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.basis_commit === active.basis_commit, '.agent/verification-evidence.json: basis_commit must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(sameStringArrays(evidence.verification_commands, active.verification_commands), '.agent/verification-evidence.json: verification_commands must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.outcome === 'passed', '.agent/verification-evidence.json: outcome must be passed when active slice exact handoff requires verification evidence');
  assert(isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at)), '.agent/verification-evidence.json: recorded_at must be an ISO-8601 string when active slice exact handoff requires verification evidence');
  if (currentHead) assert(evidence.head_sha === currentHead, '.agent/verification-evidence.json: head_sha must match current git HEAD when active slice exact handoff requires verification evidence');
} else if (evidence.subject_type === 'none') {
  assert(evidence.slice_id === null, '.agent/verification-evidence.json: slice_id must be null when subject_type is none');
  assert(evidence.goal === null, '.agent/verification-evidence.json: goal must be null when subject_type is none');
  assert(evidence.contract_ids.length === 0, '.agent/verification-evidence.json: contract_ids must be empty when subject_type is none');
  assert(evidence.basis_commit === null, '.agent/verification-evidence.json: basis_commit must be null when subject_type is none');
  assert(evidence.head_sha === null, '.agent/verification-evidence.json: head_sha must be null when subject_type is none');
  assert(evidence.verification_commands.length === 0, '.agent/verification-evidence.json: verification_commands must be empty when subject_type is none');
  assert(evidence.outcome === 'not_recorded', '.agent/verification-evidence.json: outcome must be not_recorded when subject_type is none');
  assert(evidence.recorded_at === null, '.agent/verification-evidence.json: recorded_at must be null when subject_type is none');
} else {
  assert(evidence.outcome === 'passed', '.agent/verification-evidence.json: outcome must be passed when verification evidence is recorded');
  assert(isNonEmptyStringArray(evidence.verification_commands), '.agent/verification-evidence.json: verification_commands must be a non-empty array when verification evidence is recorded');
  assert(isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at)), '.agent/verification-evidence.json: recorded_at must be an ISO-8601 string when verification evidence is recorded');
  if (currentHead) assert(evidence.head_sha === currentHead, '.agent/verification-evidence.json: head_sha must match current git HEAD when verification evidence is recorded');
  if (evidence.subject_type === 'selected_slice') {
    assert(isNonEmptyString(evidence.slice_id), '.agent/verification-evidence.json: slice_id must be a non-empty string when subject_type is selected_slice');
    assert(isNonEmptyString(evidence.goal), '.agent/verification-evidence.json: goal must be a non-empty string when subject_type is selected_slice');
    assert(isNonEmptyString(evidence.basis_commit), '.agent/verification-evidence.json: basis_commit must be a non-empty string when subject_type is selected_slice');
  } else {
    assert(evidence.subject_type === 'current_head', '.agent/verification-evidence.json: only current_head or selected_slice may carry recorded verification evidence');
  }
}

if (!requiresExactHandoff) {
  assert(active.priority === null || active.priority === undefined || (typeof active.priority === 'number' && Number.isFinite(active.priority)), '.agent/active-slice.json: idle priority must be null/undefined or a finite number');
  assert(active.why_now === null || active.why_now === undefined || typeof active.why_now === 'string', '.agent/active-slice.json: idle why_now must be null/undefined or a string');
}
NODE
`;
}

async function ensureGitignore(root: string): Promise<boolean> {
	const gitignorePath = path.join(root, ".gitignore");
	const blockLines = [
		"# completion protocol",
		".agent/*",
		"!.agent/README.md",
		"!.agent/mission.md",
		"!.agent/profile.json",
		"!.agent/verify_completion_stop.sh",
		"!.agent/verify_completion_control_plane.sh",
		".agent/tmp/",
	];
	const block = blockLines.join("\n");
	const existing = (await pathExists(gitignorePath)) ? await fsp.readFile(gitignorePath, "utf8") : "";
	const filteredLines = existing
		.split(/\r?\n/)
		.filter((line) => !blockLines.includes(line.trim()));
	while (filteredLines.length > 0 && filteredLines[filteredLines.length - 1]?.trim() === "") {
		filteredLines.pop();
	}
	const base = filteredLines.join("\n").trimEnd();
	const content = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
	if (content === existing) return false;
	await fsp.writeFile(gitignorePath, content, "utf8");
	return true;
}

type ScaffoldResult = {
	root: string;
	created: string[];
	updated: string[];
	missionAnchor: string;
};

async function scaffoldCompletionFiles(
	root: string,
	missionAnchor: string,
	options?: { analysis?: ContextProposalAnalysis; continuationReason?: string },
): Promise<ScaffoldResult> {
	const files = resolveFiles(root);
	const created: string[] = [];
	const updated: string[] = [];
	await fsp.mkdir(files.agentDir, { recursive: true });
	await fsp.mkdir(path.join(files.agentDir, "tmp"), { recursive: true });
	const projectName = path.basename(root);
	const routing = finalizeContextProposalAnalysis(options?.analysis, [missionAnchor]);
	const docsSurfaces = await detectDocsSurfaces(root);
	const verifierCommand = await detectVerifierCommand(root);
	const trackedFiles: Array<{ path: string; content: string; executable?: boolean }> = [
		{ path: path.join(files.agentDir, "README.md"), content: buildAgentReadme(projectName) },
		{ path: path.join(files.agentDir, "mission.md"), content: buildMission(projectName, missionAnchor) },
		{
			path: files.profilePath,
			content: `${JSON.stringify(buildProfileRecord({ projectName, requiredStopJudges: 3, docsSurfaces, taskType: routing.taskType, evaluationProfile: routing.evaluationProfile }), null, 2)}\n`,
		},
		{ path: path.join(files.agentDir, "verify_completion_stop.sh"), content: buildVerifyStopScript(verifierCommand), executable: true },
		{ path: path.join(files.agentDir, "verify_completion_control_plane.sh"), content: buildVerifyControlPlaneScript(), executable: true },
		{
			path: files.statePath,
			content: `${JSON.stringify(defaultState(missionAnchor, { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile, continuationReason: options?.continuationReason }), null, 2)}\n`,
		},
		{ path: files.planPath, content: `${JSON.stringify(defaultPlan(missionAnchor, { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile }), null, 2)}\n` },
		{ path: files.activePath, content: `${JSON.stringify(defaultActiveSlice(missionAnchor, { taskType: routing.taskType, evaluationProfile: routing.evaluationProfile }), null, 2)}\n` },
		{ path: files.verificationEvidencePath, content: `${JSON.stringify(defaultVerificationEvidence(), null, 2)}\n` },
		{ path: files.sliceHistoryPath, content: "" },
		{ path: files.stopHistoryPath, content: "" },
	];
	for (const file of trackedFiles) {
		if (await pathExists(file.path)) continue;
		await fsp.writeFile(file.path, file.content, "utf8");
		if (file.executable) await fsp.chmod(file.path, 0o755);
		created.push(path.relative(root, file.path));
	}
	if (await ensureGitignore(root)) updated.push(".gitignore");
	return { root, created, updated, missionAnchor };
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

function buildSystemReminder(snapshot: CompletionStateSnapshot, sliceHistory: JsonRecord[], stopHistory: JsonRecord[]): string {
	const history = historyCounts(sliceHistory, stopHistory);
	const implementationSurfaces = asStringArray(snapshot.active?.implementation_surfaces);
	const verificationCommands = asStringArray(snapshot.active?.verification_commands);
	const activePriority = asNumber(snapshot.active?.priority);
	const activeWhyNow = asString(snapshot.active?.why_now);
	const nextRole = asString(snapshot.state?.next_mandatory_role);
	const exactActiveContract = activeCarriesExactHandoff(snapshot.active);
	const activeContractDrift = activeSliceContractDriftSummary(snapshot);
	const evidence = verificationEvidenceContext(snapshot);
	const lines = [
		"Completion workflow detected.",
		"Canonical truth lives in .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, .agent/stop-check-history.jsonl, and .agent/verification-evidence.json.",
		`Mission anchor: ${asString(snapshot.state?.mission_anchor) ?? "(unknown)"}`,
		`Task type: ${currentTaskType(snapshot) ?? "(missing)"}`,
		`Evaluation profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`,
		`Current phase: ${asString(snapshot.state?.current_phase) ?? "unknown"}`,
		`Continuation policy: ${asString(snapshot.state?.continuation_policy) ?? "unknown"}`,
		`Continuation reason: ${asString(snapshot.state?.continuation_reason) ?? "(unknown)"}`,
		`Next mandatory role: ${asString(snapshot.state?.next_mandatory_role) ?? "unknown"}`,
		`Next mandatory action: ${asString(snapshot.state?.next_mandatory_action) ?? "unknown"}`,
		`Remaining slice count: ${remainingSliceCount(snapshot.plan)}`,
		`Remaining stop judges: ${asNumber(snapshot.state?.remaining_stop_judges) ?? "(unknown)"}`,
		`History counts: reviewed=${history.reviewed}, audited=${history.audited}, accepted=${history.accepted}, reopened=${history.reopened}, judgments=${history.judgments}.`,
		"Re-read canonical .agent state after compaction or recovery instead of relying on conversation memory.",
		"If continuation_policy == continue, do not stop after a slice or ask whether to continue; dispatch the next mandatory role directly.",
		"Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.",
		"If canonical state is stale, invalid, ambiguous, or missing, route to completion-regrounder.",
		"When recovering from compaction, prefer a deterministic restart from canonical files over conversational inference.",
	];
	if (exactActiveContract) {
		lines.push("Selected/in-progress/committed/done .agent/active-slice.json is the canonical implementation contract.");
		lines.push(`Active slice contract drift: ${activeContractDrift}`);
	}
	if (activePriority !== undefined) lines.push(`Active slice priority: ${activePriority}`);
	if (activeWhyNow) lines.push(`Active slice why_now: ${activeWhyNow}`);
	if (implementationSurfaces.length > 0) lines.push(`Active implementation surfaces: ${implementationSurfaces.join(", ")}`);
	if (verificationCommands.length > 0) lines.push(`Active verification commands: ${verificationCommands.join(" | ")}`);
	lines.push(`Verification evidence artifact: ${evidence.path} (${evidence.status})`);
	if (evidence.subjectType) lines.push(`Verification evidence subject: ${evidence.subjectType}`);
	if (evidence.outcome) lines.push(`Verification evidence outcome: ${evidence.outcome}`);
	if (evidence.recordedAt) lines.push(`Verification evidence recorded_at: ${evidence.recordedAt}`);
	if (evidence.verificationCommands.length > 0) lines.push(`Verification evidence commands: ${evidence.verificationCommands.join(" | ")}`);
	lines.push(`Verification evidence summary: ${evidence.summary}`);
	if (isRubricEvaluationRole(nextRole)) lines.push(buildEvaluationRoleReminderText(snapshot, nextRole));
	return lines.join(" ");
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

function buildResumeCapsule(snapshot: CompletionStateSnapshot, sliceHistory: JsonRecord[], stopHistory: JsonRecord[]): string {
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
	const activeContractDrift = activeSliceContractDriftSummary(snapshot);
	const evidence = verificationEvidenceContext(snapshot);
	const lines = [
		"Authoritative completion resume capsule:",
		"",
		"<completion-state>",
		`mission_anchor: ${asString(snapshot.state?.mission_anchor) ?? "(unknown)"}`,
		`task_type: ${currentTaskType(snapshot) ?? "(missing)"}`,
		`evaluation_profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`,
		`current_phase: ${asString(snapshot.state?.current_phase) ?? "unknown"}`,
		`continuation_policy: ${asString(snapshot.state?.continuation_policy) ?? "unknown"}`,
		`continuation_reason: ${asString(snapshot.state?.continuation_reason) ?? "(unknown)"}`,
		`requires_reground: ${asBoolean(snapshot.state?.requires_reground) ?? "unknown"}`,
		`next_mandatory_role: ${asString(snapshot.state?.next_mandatory_role) ?? "unknown"}`,
		`next_mandatory_action: ${asString(snapshot.state?.next_mandatory_action) ?? "unknown"}`,
		`remaining_slice_count: ${remainingSliceCount(snapshot.plan)}`,
		`remaining_stop_judges: ${asNumber(snapshot.state?.remaining_stop_judges) ?? "(unknown)"}`,
		`active_slice_matches_plan: ${activeSliceMatchesPlan(snapshot)}`,
		`active_slice_contract_drift_fields: ${activeContractDrift}`,
		`implementer_handoff_snapshot: ${handoffSnapshotState(snapshot.active)}`,
		`history_counts: reviewed=${history.reviewed}, audited=${history.audited}, accepted=${history.accepted}, reopened=${history.reopened}, judgments=${history.judgments}`,
		"",
		"verification_evidence:",
		`- path: ${evidence.path}`,
		`- status: ${evidence.status}`,
		`- subject_type: ${evidence.subjectType ?? "(missing)"}`,
		`- slice_id: ${evidence.sliceId ?? "(none)"}`,
		`- contract_ids: ${evidence.contractIds.length > 0 ? evidence.contractIds.join(", ") : "(none)"}`,
		`- outcome: ${evidence.outcome ?? "(missing)"}`,
		`- recorded_at: ${evidence.recordedAt ?? "(missing)"}`,
		`- head_sha: ${evidence.headSha ?? "(missing)"}`,
		`- basis_commit: ${evidence.basisCommit ?? "(missing)"}`,
		`- verification_commands: ${evidence.verificationCommands.length > 0 ? evidence.verificationCommands.join(" | ") : "(none)"}`,
		`- summary: ${evidence.summary}`,
		"",
		"active_slice:",
		`- slice_id: ${asString(snapshot.active?.slice_id) ?? asString(snapshot.activeSlice?.slice_id) ?? "(none)"}`,
		`- status: ${asString(snapshot.active?.status) ?? asString(snapshot.activeSlice?.status) ?? "unknown"}`,
		`- goal: ${asString(snapshot.active?.goal) ?? asString(snapshot.activeSlice?.goal) ?? "(unknown)"}`,
		`- priority: ${asNumber(snapshot.active?.priority) ?? "(unknown)"}`,
		`- why_now: ${asString(snapshot.active?.why_now) ?? "(unknown)"}`,
		`- contract_ids: ${contractIds.length > 0 ? contractIds.join(", ") : "(none)"}`,
	];
	if (blockedOn.length > 0) lines.push(`- blocked_on: ${blockedOn.join(", ")}`);
	if (lockedNotes.length > 0) lines.push(`- locked_notes: ${lockedNotes.join(" | ")}`);
	if (mustFixFindings.length > 0) lines.push(`- must_fix_findings: ${mustFixFindings.join(" | ")}`);
	if (implementationSurfaces.length > 0) lines.push(`- implementation_surfaces: ${implementationSurfaces.join(" | ")}`);
	if (verificationCommands.length > 0) lines.push(`- verification_commands: ${verificationCommands.join(" | ")}`);
	lines.push(`- basis_commit: ${asString(snapshot.active?.basis_commit) ?? "(none)"}`);
	lines.push(`- remaining_contract_ids_before: ${remainingBefore.length > 0 ? remainingBefore.join(", ") : "(none)"}`);
	lines.push(`- release_blocker_count_before: ${asNumber(snapshot.active?.release_blocker_count_before) ?? "(unknown)"}`);
	lines.push(`- high_value_gap_count_before: ${asNumber(snapshot.active?.high_value_gap_count_before) ?? "(unknown)"}`);
	lines.push("", "acceptance_criteria:");
	if (acceptance.length === 0) lines.push("- (none)");
	else lines.push(...acceptance.map((item) => `- ${item}`));
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

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function completionRemainingSummary(surface: {
	remainingContractCount: number;
	releaseBlockerCount: number;
	highValueGapCount: number;
	remainingStopJudgeCount: number;
}): string {
	return [
		formatCount(surface.remainingContractCount, "contract"),
		formatCount(surface.releaseBlockerCount, "blocker"),
		formatCount(surface.highValueGapCount, "gap"),
		formatCount(surface.remainingStopJudgeCount, "stop judge", "stop judges"),
	].join(" · ");
}

function envNumber(name: string): number | undefined {
	const raw = asString(process.env[name]);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function nowMs(): number {
	return envNumber("PI_COMPLETION_TEST_NOW") ?? Date.now();
}

type LiveActivitySignal = {
	state: "active" | "waiting" | "stalled";
	idleMs: number;
};

function liveActivitySignal(activity: { status?: string; startedAt?: number; updatedAt?: number } | undefined): LiveActivitySignal | undefined {
	if (!activity || activity.status !== "running") return undefined;
	const anchor = activity.updatedAt ?? activity.startedAt;
	if (anchor === undefined) return undefined;
	const idleMs = Math.max(0, nowMs() - anchor);
	return {
		state: idleMs >= LIVE_ROLE_STALLED_MS ? "stalled" : idleMs >= LIVE_ROLE_WAITING_MS ? "waiting" : "active",
		idleMs,
	};
}

function formatLiveActivitySignal(signal: LiveActivitySignal | undefined): string | undefined {
	if (!signal) return undefined;
	if (signal.state === "active") return "activity: active";
	return `activity: ${signal.state} (${formatElapsed(signal.idleMs)} since update)`;
}

function livePreviewForStatus(activity: LiveRoleActivity | undefined): string | undefined {
	if (!activity || activity.status !== "running") return undefined;
	return truncateInline(
		activity.progress ?? activity.verifying ?? activity.toolActivity ?? activity.assistantSummary ?? activity.currentAction ?? activity.lastAssistantText ?? "",
		120,
	) || undefined;
}

function cloneLiveRoleActivity(activity: LiveRoleActivity, overrides: Partial<LiveRoleActivity> = {}): LiveRoleActivity {
	return {
		...activity,
		...overrides,
		toolRecentActivity: [...(overrides.toolRecentActivity ?? activity.toolRecentActivity)],
		recentActivity: [...(overrides.recentActivity ?? activity.recentActivity)],
		stateDeltas: [...(overrides.stateDeltas ?? activity.stateDeltas)],
	};
}

function createLiveRoleActivity(role: string, startedAt = nowMs()): LiveRoleActivity {
	const currentAction = "Starting role subprocess";
	return {
		role,
		status: "running",
		currentAction,
		toolActivity: currentAction,
		toolRecentActivity: [currentAction],
		recentActivity: [currentAction],
		stateDeltas: [],
		startedAt,
		updatedAt: startedAt,
	};
}

type RoleMessage = {
	role: string;
	content: Array<{ type: string; text?: string }>;
};

function activityTimestampMs(event: JsonRecord | undefined): number | undefined {
	return asNumber(event?.updatedAt) ?? asNumber(event?.timestampMs) ?? asNumber(event?.timestamp) ?? asNumber(event?.at);
}

function asRoleMessage(value: unknown): RoleMessage | undefined {
	if (!isRecord(value)) return undefined;
	const role = asString(value.role);
	const content = Array.isArray(value.content)
		? value.content.flatMap((item) => {
				if (!isRecord(item)) return [];
				const type = asString(item.type);
				if (!type) return [];
				return [{ type, text: asString(item.text) }];
		  })
		: [];
	if (!role) return undefined;
	return { role, content };
}

function applyAssistantTextToLiveRoleActivity(activity: LiveRoleActivity, text: string, activityAt = nowMs()): boolean {
	if (!text) return false;
	activity.lastAssistantText = text;
	const parsed = parseStructuredProgress(text);
	if (parsed.progress) activity.progress = parsed.progress;
	if (parsed.rationale) activity.rationale = parsed.rationale;
	if (parsed.nextStep) activity.nextStep = parsed.nextStep;
	if (parsed.verifying) activity.verifying = parsed.verifying;
	if (parsed.stateDeltas.length > 0) activity.stateDeltas = parsed.stateDeltas;
	const preview = truncateInline(text, 140);
	activity.assistantSummary = activity.progress ?? activity.verifying ?? preview;
	activity.currentAction = activity.assistantSummary;
	if (activity.assistantSummary) activity.recentActivity = pushRecentActivity(activity.recentActivity, `assistant: ${activity.assistantSummary}`);
	activity.updatedAt = activityAt;
	return true;
}

function applyLiveRoleEvent(activity: LiveRoleActivity, event: JsonRecord, messages: RoleMessage[]): boolean {
	const eventType = asString(event.type);
	if (!eventType) return false;
	const activityAt = activityTimestampMs(event) ?? nowMs();
	if (eventType === "tool_execution_start") {
		const toolName = asString(event.toolName) ?? "tool";
		const toolArgs = isRecord(event.args) ? event.args : isRecord(event.input) ? event.input : {};
		activity.toolActivity = formatToolActivity(toolName, toolArgs);
		activity.currentAction = activity.toolActivity;
		activity.toolRecentActivity = pushRecentActivity(activity.toolRecentActivity, activity.toolActivity, 6);
		activity.recentActivity = pushRecentActivity(activity.recentActivity, activity.toolActivity);
		activity.updatedAt = activityAt;
		return true;
	}
	if (eventType === "tool_execution_end" || eventType === "tool_result_end") {
		activity.updatedAt = activityAt;
		return true;
	}
	if ((eventType === "message_update" || eventType === "message_end") && isRecord(event.message)) {
		const message = asRoleMessage(event.message);
		if (message && eventType === "message_end") messages.push(message);
		const nextOutput = message ? lastAssistantText(eventType === "message_end" ? messages : [message]) : "";
		if (nextOutput) return applyAssistantTextToLiveRoleActivity(activity, nextOutput, activityAt);
		activity.updatedAt = activityAt;
		return true;
	}
	return false;
}

function maybeInjectTestLiveRoleActivity(rootKey: string): void {
	const raw = asString(process.env.PI_COMPLETION_TEST_LIVE_ROLE_ACTIVITY_JSON);
	if (!raw) return;
	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return;
		const currentAction = asString(parsed.currentAction);
		const recentActivity = asStringArray(parsed.recentActivity).length > 0 ? asStringArray(parsed.recentActivity) : currentAction ? [currentAction] : [];
		const toolActivity =
			asString(parsed.toolActivity) ??
			(currentAction && !currentAction.startsWith("assistant:") && !currentAction.startsWith("progress:") ? currentAction : undefined);
		const assistantSummary =
			asString(parsed.assistantSummary) ??
			(currentAction?.startsWith("assistant:") ? currentAction.slice("assistant:".length).trim() : undefined);
		liveRoleActivityByRoot.set(rootKey, {
			role: asString(parsed.role) ?? "completion-implementer",
			status: asString(parsed.status) === "ok" ? "ok" : asString(parsed.status) === "error" ? "error" : "running",
			currentAction,
			toolActivity,
			toolRecentActivity: asStringArray(parsed.toolRecentActivity).length > 0 ? asStringArray(parsed.toolRecentActivity) : toolActivity ? [toolActivity] : [],
			recentActivity,
			assistantSummary,
			lastAssistantText: asString(parsed.lastAssistantText),
			progress: asString(parsed.progress),
			rationale: asString(parsed.rationale),
			nextStep: asString(parsed.nextStep),
			verifying: asString(parsed.verifying),
			stateDeltas: asStringArray(parsed.stateDeltas),
			startedAt: asNumber(parsed.startedAt) ?? nowMs(),
			updatedAt: asNumber(parsed.updatedAt) ?? nowMs(),
		});
	} catch {
		// ignore malformed test override
	}
}

function maybeReplayTestLiveRoleEvents(rootKey: string): void {
	const raw = asString(process.env.PI_COMPLETION_TEST_ROLE_EVENT_STREAM_JSON);
	if (!raw) return;
	try {
		const parsed = JSON.parse(raw);
		let role = "completion-implementer";
		let status: LiveRoleActivity["status"] = "running";
		let startedAt = nowMs();
		let events: JsonRecord[] = [];
		if (Array.isArray(parsed)) {
			events = parsed.filter(isRecord);
		} else if (isRecord(parsed)) {
			role = asString(parsed.role) ?? role;
			status = asString(parsed.status) === "ok" ? "ok" : asString(parsed.status) === "error" ? "error" : "running";
			startedAt = asNumber(parsed.startedAt) ?? asNumber(parsed.started_at) ?? startedAt;
			events = Array.isArray(parsed.events) ? parsed.events.filter(isRecord) : [];
		} else {
			return;
		}
		const activity = createLiveRoleActivity(role, startedAt);
		const messages: RoleMessage[] = [];
		for (const event of events) applyLiveRoleEvent(activity, event, messages);
		liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(activity, { status }));
	} catch {
		// ignore malformed event stream override
	}
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

function formatElapsed(ms: number | undefined): string {
	if (!ms || ms < 0) return "00:00";
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncateInline(text: string, maxLength = 120): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 3)}...` : singleLine;
}


function formatToolActivity(toolName: string, args: JsonRecord): string {
	if (toolName === "bash") return `$ ${truncateInline(asString(args.command) ?? "...")}`;
	if (toolName === "read") return `read ${asString(args.filePath) ?? asString(args.path) ?? "..."}`;
	if (toolName === "write") return `write ${asString(args.filePath) ?? asString(args.path) ?? "..."}`;
	if (toolName === "edit") return `edit ${asString(args.filePath) ?? asString(args.path) ?? "..."}`;
	if (toolName === "grep") return `grep ${asString(args.pattern) ?? "..."}`;
	if (toolName === "find") return `find ${asString(args.pattern) ?? "..."}`;
	if (toolName === "ls") return `ls ${asString(args.path) ?? "."}`;
	return `${toolName} ${truncateInline(JSON.stringify(args))}`;
}

function pushRecentActivity(items: string[], line: string, maxItems = 8): string[] {
	const normalized = truncateInline(line, 160);
	if (!normalized) return items;
	if (items[items.length - 1] === normalized) return items;
	const next = [...items, normalized];
	return next.slice(-maxItems);
}

function collapseRecentActivity(items: string[], maxItems = 4): string[] {
	const collapsed: string[] = [];
	for (const rawItem of items) {
		const item = truncateInline(rawItem, 120);
		if (!item || item.startsWith("done ") || item.startsWith("result ")) continue;
		if (item.startsWith("assistant:")) continue;
		if (collapsed[collapsed.length - 1] === item) continue;
		collapsed.push(item);
	}
	return collapsed.slice(-maxItems);
}

function formatInlineRunningText(theme: any, lines: string[], options?: { primaryAssistant?: boolean }): string {
	let text = "";
	for (const [index, line] of lines.entries()) {
		if (index > 0) text += "\n";
		if (index === 0) {
			const [prefix, ...rest] = line.split(" ");
			text += theme.fg("warning", prefix);
			if (rest.length > 0) text += ` ${theme.fg("accent", rest.join(" "))}`;
			continue;
		}
		if (line.startsWith("tool:") || line.startsWith("progress:")) {
			text += theme.fg("toolOutput", line);
			continue;
		}
		if (line.startsWith("activity:")) {
			text += line.includes("stalled") ? theme.fg("warning", line) : line;
			continue;
		}
		if (line === "recent tools:") {
			text += theme.fg("muted", line);
			continue;
		}
		if (line.startsWith("- ")) {
			text += `${theme.fg("muted", "- ")}${theme.fg("muted", line.slice(2))}`;
			continue;
		}
		if (line.startsWith("elapsed:")) {
			text += line;
			continue;
		}
		if (line.startsWith("assistant:")) {
			text += options?.primaryAssistant ? line : theme.fg("muted", line);
			continue;
		}
		if (line.startsWith("next:") || line.startsWith("verifying:")) {
			text += theme.fg("muted", line);
			continue;
		}
		if (line.startsWith("rationale:") || line.startsWith("state-delta:")) {
			text += line;
			continue;
		}
		text += theme.fg("muted", line);
	}
	return text;
}

function buildInlineRunningLines(details: {
	role?: string;
	startedAt?: number;
	updatedAt?: number;
	currentAction?: string;
	toolActivity?: string;
	toolRecentActivity?: string[];
	recentActivity?: string[];
	assistantSummary?: string;
	progress?: string;
	rationale?: string;
	nextStep?: string;
	verifying?: string;
	stateDeltas?: string[];
}): string[] {
	const lines: string[] = [];
	let header = "running completion role";
	if (details.role) header += ` ${details.role}`;
	lines.push(header);
	if (details.startedAt !== undefined) lines.push(`elapsed: ${formatElapsed(nowMs() - details.startedAt)}`);
	const signalLine = formatLiveActivitySignal(
		liveActivitySignal({ status: "running", startedAt: details.startedAt, updatedAt: details.updatedAt }),
	);
	if (signalLine) lines.push(signalLine);
	const toolLine = details.toolActivity;
	if (toolLine) lines.push(`tool: ${toolLine}`);
	if (details.progress) lines.push(`progress: ${details.progress}`);
	else if (details.assistantSummary) lines.push(`assistant: ${details.assistantSummary}`);
	else if (details.currentAction && details.currentAction !== toolLine) {
		lines.push(`assistant: ${details.currentAction.replace(/^assistant:\s*/, "")}`);
	}
	if (details.rationale) lines.push(`rationale: ${details.rationale}`);
	if (details.nextStep) lines.push(`next: ${details.nextStep}`);
	if (details.verifying) lines.push(`verifying: ${details.verifying}`);
	for (const delta of (details.stateDeltas ?? []).slice(-4)) lines.push(`state-delta: ${delta}`);
	const recentTools = collapseRecentActivity(details.toolRecentActivity ?? details.recentActivity ?? []);
	const recentWithoutCurrent = recentTools.filter((item) => item !== toolLine);
	if (recentWithoutCurrent.length > 0) {
		lines.push("recent tools:");
		for (const item of recentWithoutCurrent) lines.push(`- ${item}`);
	}
	return lines;
}

function parseStructuredProgress(text: string): {
	progress?: string;
	rationale?: string;
	nextStep?: string;
	verifying?: string;
	stateDeltas: string[];
} {
	const result: { progress?: string; rationale?: string; nextStep?: string; verifying?: string; stateDeltas: string[] } = {
		stateDeltas: [],
	};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^(PROGRESS|RATIONALE|NEXT|VERIFYING|STATE-DELTA):\s*(.+)$/i);
		if (!match) continue;
		const [, rawKey, rawValue] = match;
		const key = rawKey.toUpperCase();
		const value = rawValue.trim();
		if (!value) continue;
		if (key === "PROGRESS") result.progress = value;
		else if (key === "RATIONALE") result.rationale = value;
		else if (key === "NEXT") result.nextStep = value;
		else if (key === "VERIFYING") result.verifying = value;
		else if (key === "STATE-DELTA") result.stateDeltas.push(value);
	}
	if (result.stateDeltas.length > 6) result.stateDeltas = result.stateDeltas.slice(-6);
	return result;
}

function lastAssistantText(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const texts = message.content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text?.trim())
			.filter((part): part is string => Boolean(part));
		if (texts.length > 0) return texts.join("\n\n");
	}
	return "";
}

function completionKickoff(
	goal: string,
	taskType: string,
	evaluationProfile: string,
	intent: "auto" | "continue" | "refocus" = "auto",
	missionAnchor?: string,
): string {
	const intentBlock =
		intent === "continue" && missionAnchor
			? `Existing canonical mission anchor:\n${missionAnchor}\n\nWorkflow intent:\n- Continue the existing workflow.\n- Treat the new user text as supplemental direction unless canonical reconciliation proves the mission itself must change.\n\n`
			: intent === "refocus" && missionAnchor
				? `Updated canonical mission anchor:\n${missionAnchor}\n\nWorkflow intent:\n- The user explicitly refocused the workflow before this kickoff.\n- Re-read canonical .agent/** state and continue from the refocused mission.\n\n`
				: "";
	return `/skill:completion-protocol Start or continue the completion workflow for this repo.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\nUser goal:\n${goal}\n\n${intentBlock}Driver instructions:\n- Canonical truth is in .agent/**. Re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, and .agent/verification-evidence.json before acting when they exist.\n- If tracked completion contract files are missing or onboarding is required, invoke completion_role with role completion-bootstrapper.\n- Otherwise follow the mandatory dispatch rules from completion-protocol.\n- For selected, in-progress, committed, or done slices, treat .agent/active-slice.json as the canonical implementation contract and route to completion-regrounder if it drifts from the selected plan slice or the exact handoff is unclear.\n- Consume .agent/verification-evidence.json instead of temp-only verification summaries when it is populated.\n- Use completion_role for all completion-* role work. Do not directly implement tracked product changes yourself.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
}

function completionResumePrompt(taskType: string, evaluationProfile: string): string {
	return `/skill:completion-protocol Resume the completion workflow from canonical state.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\nResume instructions:\n- Re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, and .agent/verification-evidence.json before acting.\n- If canonical state is missing, invalid, contradictory, stale, or ambiguous, route to completion-regrounder first.\n- For selected, in-progress, committed, or done slices, treat .agent/active-slice.json as the canonical implementation contract and route to completion-regrounder if it drifts from the selected plan slice or the exact handoff is unclear.\n- Consume .agent/verification-evidence.json instead of temp-only verification summaries when it is populated.\n- Continue from next_mandatory_role and next_mandatory_action.\n- Use completion_role for all completion-* role work.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
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
			description: "Bare /cook workflow: start, continue, refocus, or start the next round",
		},
		buildContextProposalContinuationReason,
		completionKickoff,
		completionResumePrompt,
		completionRootKey,
		completionTestAutoContinuePromptPath,
		completionTestDriverPromptPath,
		completionTestExistingWorkflowChooserSnapshotPath,
		completionTestWorkflowActionOverride,
		confirmContextProposal,
		deriveCookContextProposal,
		emitCommandText,
		finalizeContextProposalAnalysis,
		getCtxCwd,
		getCtxHasUI,
		getCtxUi,
		hasRunningCompletionRole,
		maybeWriteActiveWorkflowRoutingSnapshot,
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
			await autoContinueWorkflowIfNeeded(pi, ctx, driverDeps);
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
		await autoContinueWorkflowIfNeeded(pi, ctx, driverDeps);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const loaded = await loadCompletionDataForReminder(getCtxCwd(ctx));
		if (loaded) {
			const rootKey = completionRootKey(loaded.snapshot, getCtxCwd(ctx));
			const fingerprint = completionContinuationFingerprint(loaded.snapshot);
			if (fingerprint) markQueuedDriverPromptInFlight(rootKey, fingerprint);
		}
		if (!loaded || !shouldInjectCompletionWorkflowContext(loaded.snapshot)) return;
		const additions = isWorkflowDone(loaded.snapshot)
			? [buildDoneWorkflowBoundaryReminder(loaded.snapshot)]
			: [buildSystemReminder(loaded.snapshot, loaded.sliceHistory, loaded.stopHistory)];
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
		const summary = buildResumeCapsule(loaded.snapshot, loaded.sliceHistory, loaded.stopHistory);
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
