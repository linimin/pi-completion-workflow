import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as roleReporting from "./role-reporting.js";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

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
const PACKAGE_AGENTS_DIR = PACKAGE_ROOT ? path.join(PACKAGE_ROOT, "agents") : undefined;
const SKILL_PATH = PACKAGE_SKILL_PATH ?? path.join(AGENT_HOME, "skills", "completion-protocol", "SKILL.md");
const REFERENCE_PATH = PACKAGE_REFERENCE_PATH ?? path.join(AGENT_HOME, "skills", "completion-protocol", "references", "completion.md");
const DEFAULT_TASK_TYPE = "completion-workflow";
const DEFAULT_EVALUATION_PROFILE = "completion-rubric-v1";
const RUBRIC_EVALUATION_ROLES = ["completion-reviewer", "completion-auditor", "completion-stop-judge"] as const;

type RubricEvaluationRole = (typeof RUBRIC_EVALUATION_ROLES)[number];

type CompletionRole = (typeof ROLE_NAMES)[number];
type JsonRecord = Record<string, unknown>;

type CompletionFiles = {
	root: string;
	agentDir: string;
	tmpDir: string;
	profilePath: string;
	statePath: string;
	planPath: string;
	activePath: string;
	sliceHistoryPath: string;
	stopHistoryPath: string;
	compactionMarkerPath: string;
};

type CompletionStateSnapshot = {
	files: CompletionFiles;
	profile?: JsonRecord;
	state?: JsonRecord;
	plan?: JsonRecord;
	active?: JsonRecord;
	activeSlice?: JsonRecord;
};

type AgentDefinition = {
	name: string;
	description?: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
};

type LiveRoleActivity = {
	role: string;
	status: "running" | "ok" | "error";
	currentAction?: string;
	toolActivity?: string;
	toolRecentActivity: string[];
	recentActivity: string[];
	assistantSummary?: string;
	lastAssistantText?: string;
	progress?: string;
	rationale?: string;
	nextStep?: string;
	verifying?: string;
	stateDeltas: string[];
	startedAt: number;
	updatedAt: number;
};

type CompletionStatusSurface = {
	snapshotPresent: boolean;
	statusText?: string;
	widgetLines: string[];
	currentPhase?: string;
	sliceId?: string;
	nextMandatoryRole?: string;
	remainingContractCount?: number;
	releaseBlockerCount?: number;
	highValueGapCount?: number;
	remainingStopJudgeCount?: number;
	activeRole?: string;
	livePreview?: string;
	liveState?: "active" | "waiting" | "stalled";
	liveIdleMs?: number;
	liveToolActivity?: string;
	liveAssistantSummary?: string;
	liveProgress?: string;
	liveRationale?: string;
	liveNextStep?: string;
	liveVerifying?: string;
	liveStateDeltas?: string[];
	liveDetailsLines?: string[];
};

type ContextProposal = {
	mission: string;
	scope: string[];
	constraints: string[];
	acceptance: string[];
	goalText: string;
	basisPreview: string;
	source: "session" | "analyst";
};

type RecentDiscussionEntry = {
	role: "user" | "assistant" | "custom" | "summary";
	text: string;
};

type ContextProposalDecision = {
	missionAnchor: string;
	goalText: string;
};

type ContextProposalConfirmAction = "start" | "edit" | "cancel";

type ContextProposalConfirmationActionItem = {
	id: ContextProposalConfirmAction;
	label: string;
	description: string;
};

type ContextProposalConfirmationLayout = {
	title: string;
	intro: string;
	proposalHeading: string;
	proposalBody: string;
	actionsHeading: string;
	actions: ContextProposalConfirmationActionItem[];
	footer: string;
};

type ContextProposalConfirmOptions = {
	title: string;
	nonInteractiveBehavior?: "accept" | "cancel";
	editorPrompt?: string;
};

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
		this.body.setText(this.theme.fg("dim", this.lines.join("\n")));
		this.footer.setText(this.theme.fg("muted", "Esc cancel • This analysis runs before /cook writes canonical workflow state"));
	}

	override handleInput(data: string): void {
		if (data === "\u001b") {
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
const LIVE_ROLE_WAITING_MS = 15_000;
const LIVE_ROLE_STALLED_MS = 45_000;
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

function resolveFiles(root: string): CompletionFiles {
	const agentDir = path.join(root, ".agent");
	const tmpDir = path.join(agentDir, "tmp");
	return {
		root,
		agentDir,
		tmpDir,
		profilePath: path.join(agentDir, "profile.json"),
		statePath: path.join(agentDir, "state.json"),
		planPath: path.join(agentDir, "plan.json"),
		activePath: path.join(agentDir, "active-slice.json"),
		sliceHistoryPath: path.join(agentDir, "slice-history.jsonl"),
		stopHistoryPath: path.join(agentDir, "stop-check-history.jsonl"),
		compactionMarkerPath: path.join(tmpDir, "post-compaction-recovery.json"),
	};
}

function walkUpForDir(startCwd: string, segments: string[]): string | undefined {
	let current = path.resolve(startCwd);
	while (true) {
		const candidate = path.join(current, ...segments);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findCompletionRoot(startCwd: string): string | undefined {
	const profilePath = walkUpForDir(startCwd, [".agent", "profile.json"]);
	return profilePath ? path.dirname(path.dirname(profilePath)) : undefined;
}

function findRepoRoot(startCwd: string): string | undefined {
	const gitPath = walkUpForDir(startCwd, [".git"]);
	return gitPath ? path.dirname(gitPath) : undefined;
}

async function readJson(filePath: string): Promise<JsonRecord | undefined> {
	try {
		const raw = await fsp.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function readJsonl(filePath: string): Promise<JsonRecord[]> {
	try {
		const raw = await fsp.readFile(filePath, "utf8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const parsed = JSON.parse(line);
					return isRecord(parsed) ? [parsed] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
	await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidateSlices(plan: JsonRecord | undefined): JsonRecord[] {
	const slices = plan?.candidate_slices;
	return Array.isArray(slices) ? slices.filter(isRecord) : [];
}

function findActiveSlice(plan: JsonRecord | undefined, active: JsonRecord | undefined): JsonRecord | undefined {
	const sliceId = asString(active?.slice_id);
	if (!sliceId) return undefined;
	return candidateSlices(plan).find((slice) => asString(slice.slice_id) === sliceId);
}

async function loadCompletionSnapshot(startCwd: string): Promise<CompletionStateSnapshot | undefined> {
	const root = findCompletionRoot(startCwd);
	if (!root) return undefined;
	const files = resolveFiles(root);
	const profile = await readJson(files.profilePath);
	if (asString(profile?.protocol_id) !== PROTOCOL_ID) return undefined;
	const state = await readJson(files.statePath);
	const plan = await readJson(files.planPath);
	const active = await readJson(files.activePath);
	return {
		files,
		profile,
		state,
		plan,
		active,
		activeSlice: findActiveSlice(plan, active),
	};
}

async function loadCompletionDataForReminder(startCwd: string) {
	const snapshot = await loadCompletionSnapshot(startCwd);
	if (!snapshot) return undefined;
	const sliceHistory = await readJsonl(snapshot.files.sliceHistoryPath);
	const stopHistory = await readJsonl(snapshot.files.stopHistoryPath);
	return { snapshot, sliceHistory, stopHistory };
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fsp.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function readText(filePath: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

async function detectDocsSurfaces(root: string): Promise<string[]> {
	const candidates = ["README.md", "docs/", "docs", "CHANGELOG.md"];
	const found: string[] = [];
	for (const candidate of candidates) {
		if (await pathExists(path.join(root, candidate))) found.push(candidate.endsWith("/") ? candidate : candidate.replace(/\/$/, ""));
	}
	return found.length > 0 ? found : ["README.md"];
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
	needsConfirmation: boolean;
	reason?: string;
};

function assessMissionAnchor(rawGoal: string, projectName: string): MissionAnchorAssessment {
	const normalized = normalizeMissionAnchorText(rawGoal);
	const derived = deriveMissionAnchor(rawGoal, projectName);
	if (!normalized) {
		return {
			derived,
			needsConfirmation: true,
			reason: "No meaningful goal text was provided.",
		};
	}
	if (isWeakMissionAnchor(normalized)) {
		return {
			derived,
			needsConfirmation: true,
			reason: "The goal is too short or vague for stable canonical workflow state.",
		};
	}
	const vaguePronouns = /\b(this|that|it|things|stuff|something)\b/i.test(normalized);
	const fallback = derived === `Drive ${projectName} to truthful, verifiable completion.`;
	if (fallback || vaguePronouns) {
		return {
			derived,
			needsConfirmation: true,
			reason: fallback
				? "The initial goal was too ambiguous, so the workflow fell back to a generic repo-based mission."
				: "The goal still contains ambiguous references that are better confirmed before writing canonical state.",
		};
	}
	return { derived, needsConfirmation: false };
}

async function confirmMissionAnchor(
	ctx: { hasUI: boolean; ui: any },
	assessment: MissionAnchorAssessment,
): Promise<string | undefined> {
	if (!getCtxHasUI(ctx)) return assessment.derived;
	const ui = getCtxUi(ctx);
	if (!ui) return assessment.derived;
	if (!assessment.needsConfirmation) return assessment.derived;
	const title = "Confirm mission anchor";
	const reason = assessment.reason ? `${assessment.reason}\n\n` : "";
	const choice = await ui.select(
		title,
		[
			`${reason}Proposed mission anchor:\n${assessment.derived}\n\nUse proposed mission anchor`,
			"Edit mission anchor",
			"Cancel",
		],
	);
	if (!choice || choice === "Cancel") return undefined;
	if (choice === "Edit mission anchor") {
		const edited = await ui.editor(title, assessment.derived);
		return edited?.trim() ? edited.trim() : undefined;
	}
	return assessment.derived;
}

type ExistingWorkflowDecision =
	| { action: "continue"; currentMissionAnchor: string }
	| { action: "refocus"; currentMissionAnchor: string; missionAnchor: string };

function completionTestWorkflowActionOverride(): "continue" | "refocus" | undefined {
	const raw = process.env.PI_COMPLETION_EXISTING_WORKFLOW_ACTION?.trim().toLowerCase();
	return raw === "continue" || raw === "refocus" ? raw : undefined;
}

function shouldSkipDriverKickoffForTests(): boolean {
	return process.env.PI_COMPLETION_SKIP_DRIVER_KICKOFF === "1";
}

function completionTestContextProposalActionOverride(): "accept" | "edit" | "cancel" | undefined {
	const raw = process.env.PI_COMPLETION_CONTEXT_PROPOSAL_ACTION?.trim().toLowerCase();
	return raw === "accept" || raw === "edit" || raw === "cancel" ? raw : undefined;
}

function completionTestContextProposalEditText(): string | undefined {
	return asString(process.env.PI_COMPLETION_CONTEXT_PROPOSAL_EDIT_TEXT);
}

function completionTestContextProposalUiActionOverride(): ContextProposalConfirmAction | undefined {
	const raw = process.env.PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_ACTION?.trim().toLowerCase();
	return raw === "start" || raw === "edit" || raw === "cancel" ? raw : undefined;
}

function completionTestContextProposalUiSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_PATH);
}

function completionTestDriverPromptPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_DRIVER_PROMPT_PATH);
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

function shouldDisableContextProposalAnalyst(): boolean {
	return process.env.PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST === "1";
}

function completionTestContextProposalAnalystOutput(): string | undefined {
	return asString(process.env.PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT);
}

function isWorkflowDone(snapshot: CompletionStateSnapshot | undefined): boolean {
	return asString(snapshot?.state?.continuation_policy) === "done";
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

function normalizeProposalLine(line: string): string {
	return line
		.replace(/^[-*+]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^\[.?\]\s+/, "")
		.replace(/^>\s*/, "")
		.replace(/^[`*_~]+|[`*_~]+$/g, "")
		.replace(/^\*\*(.+)\*\*$/u, "$1")
		.replace(/^__([^_]+)__$/u, "$1")
		.trim();
}

function detectProposalSection(line: string): "mission" | "scope" | "constraints" | "acceptance" | undefined {
	const normalized = normalizeProposalLine(line)
		.toLowerCase()
		.replace(/[:：]$/, "")
		.trim();
	if (!normalized) return undefined;
	if (["mission", "goal", "objective", "summary", "目標", "任務", "計劃", "计划", "方案"].includes(normalized)) return "mission";
	if (["scope", "plan", "steps", "implementation", "範圍", "范围", "實作", "实现", "步驟", "步骤"].includes(normalized)) return "scope";
	if (["constraints", "constraint", "guardrails", "non-goals", "限制", "約束", "约束", "非目標", "非目标"].includes(normalized)) return "constraints";
	if (["acceptance", "acceptance criteria", "deliverables", "verification", "驗收", "验收", "交付", "驗證", "验证"].includes(normalized)) return "acceptance";
	return undefined;
}

function matchInlineProposalSection(
	line: string,
): { section: "mission" | "scope" | "constraints" | "acceptance"; content: string } | undefined {
	const normalized = normalizeProposalLine(line);
	const match = normalized.match(/^([^:：]+)[:：]\s*(.+)$/u);
	if (!match) return undefined;
	const [, rawLabel, rawContent] = match;
	const section = detectProposalSection(rawLabel);
	const content = rawContent.trim();
	if (!section || !content) return undefined;
	return { section, content };
}

function bulletText(line: string): string | undefined {
	if (!/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) return undefined;
	const normalized = normalizeProposalLine(line);
	return normalized.length > 0 ? normalized : undefined;
}

function looksLikeConstraint(text: string): boolean {
	return /(do not|don't|must not|avoid|without|keep\b|preserve|retain|remain|不要|不可|不能|不應|不应|保持|保留|避免)/i.test(text);
}

function looksLikeAcceptance(text: string): boolean {
	return /(test|tests|testing|verify|verification|validated|README|docs?|documentation|regression|observability|驗證|验证|測試|测试|文件|文檔|文档|回歸|回归)/i.test(text);
}

function uniqueProposalItems(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of items) {
		const normalized = normalizeProposalLine(item).replace(/\s+/g, " ").trim();
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
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

const CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT = [
	"You analyze recent /cook startup discussion and return a strict JSON object.",
	"Do not emit markdown, code fences, or commentary.",
	"Return exactly one JSON object with keys: mission, scope, constraints, acceptance, confidence, possible_noise.",
	"mission must be a concise implementation mission anchor sentence.",
	"scope must contain only work items that directly support the mission.",
	"constraints must contain guardrails or non-goals explicitly stated or strongly implied by the discussion.",
	"acceptance must contain verifiable outcomes explicitly stated or strongly implied by the discussion.",
	"possible_noise should list discussion points that look stale, weakly related, or unsafe to promote into scope.",
	"When an explicit goal is provided, keep the mission anchored to that goal instead of replacing it with a broader or different mission.",
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
		if (messageRole === "user" || messageRole === "assistant" || messageRole === "custom") {
			text = extractTextFromMessageContent(message.content);
			role = messageRole;
		} else if (messageRole === "branchSummary" || messageRole === "compactionSummary") {
			text = asString(message.summary) ?? "";
			role = "summary";
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

function parseContextProposalAnalystOutput(
	raw: string,
	projectName: string,
	explicitGoal?: string,
): ContextProposal | undefined {
	const jsonText = extractJsonObjectFromText(raw);
	if (!jsonText) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const explicit = explicitGoal ? parseContextProposal(explicitGoal, projectName) : undefined;
	const missionSource = explicit?.mission ?? explicitGoal ?? asString(parsed.mission);
	if (!missionSource) return undefined;
	const assessment = assessMissionAnchor(missionSource, projectName);
	const normalizedMission = normalizeMissionAnchorText(missionSource);
	if (!normalizedMission || isWeakMissionAnchor(normalizedMission)) return undefined;
	const mission = assessment.derived;
	const scope = uniqueProposalItems(asStringArray(parsed.scope));
	const constraints = uniqueProposalItems(asStringArray(parsed.constraints));
	const acceptance = uniqueProposalItems(asStringArray(parsed.acceptance));
	const goalText = buildContextProposalGoalText({ mission, scope, constraints, acceptance });
	return {
		mission,
		scope,
		constraints,
		acceptance,
		goalText,
		basisPreview: raw.replace(/\s+/g, " ").trim(),
		source: "analyst",
	};
}

function contextProposalAnalystModelArg(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const provider = asString(model.provider);
	const id = asString(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

function buildContextProposalAnalystPrompt(projectName: string, recentEntries: RecentDiscussionEntry[], explicitGoal?: string): string {
	const discussion = serializeRecentDiscussionEntries(recentEntries);
	return [
		`Project: ${projectName}`,
		explicitGoal
			? `Explicit goal (keep this mission anchor):\n${explicitGoal}`
			: "Explicit goal: none provided; infer the current mission from the discussion.",
		"",
		"Recent discussion:",
		discussion,
	].join("\n");
}

function contextProposalAnalystProgressLines(activity: LiveRoleActivity): string[] {
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

async function runContextProposalAnalystSubprocess(
	ctx: { cwd: string; hasUI: boolean; ui: any; model?: any },
	projectName: string,
	recentEntries: RecentDiscussionEntry[],
	explicitGoal?: string,
): Promise<string | undefined> {
	const modelArg = contextProposalAnalystModelArg(ctx.model);
	if (!modelArg) return undefined;
	const cwd = getCtxCwd(ctx);
	const runCwd = findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? cwd;
	const rootKey = completionRootKey(undefined, cwd);
	const prompt = buildContextProposalAnalystPrompt(projectName, recentEntries, explicitGoal);
	const systemPromptTemp = await writeTempFile("pi-cook-proposal-analyst-", CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT);
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
		void refreshStatus(ctx);
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
					if (buffer.trim()) processLine(buffer);
					resolve(code === 0 ? liveActivity.lastAssistantText?.trim() || undefined : undefined);
				});
				proc.on("error", () => resolve(undefined));
				if (overlay) {
					overlay.onAbort = () => {
						proc.kill("SIGTERM");
						resolve(undefined);
					};
				}
			});
			liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: output ? "ok" : "error" }));
			await refreshStatus(ctx);
			return output;
		} finally {
			clearInterval(heartbeat);
			setTimeout(() => {
				const current = liveRoleActivityByRoot.get(rootKey);
				if (current && current.role === analystRole && current.status !== "running") {
					liveRoleActivityByRoot.delete(rootKey);
					void refreshStatus(ctx);
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
	explicitGoal?: string,
): Promise<ContextProposal | undefined> {
	if (shouldDisableContextProposalAnalyst()) return undefined;
	const testOutput = completionTestContextProposalAnalystOutput();
	if (testOutput) {
		return parseContextProposalAnalystOutput(testOutput, projectName, explicitGoal);
	}
	if (recentEntries.length === 0) return undefined;
	try {
		const raw = await runContextProposalAnalystSubprocess(ctx, projectName, recentEntries, explicitGoal);
		if (!raw) return undefined;
		return parseContextProposalAnalystOutput(raw, projectName, explicitGoal);
	} catch (error) {
		console.warn("[completion] context proposal analyst failed", error);
		return undefined;
	}
}

function buildContextProposalGoalText(proposal: {
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

function buildContextProposalDisplayText(proposal: ContextProposal): string {
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

function buildContextProposalConfirmationActions(): ContextProposalConfirmationActionItem[] {
	return [
		{
			id: "start",
			label: "Start",
			description: "Accept this proposal and let /cook write or refocus canonical workflow state.",
		},
		{
			id: "edit",
			label: "Edit",
			description: "Open the existing proposal editor before starting the workflow.",
		},
		{
			id: "cancel",
			label: "Cancel",
			description: "Exit without changing canonical workflow state.",
		},
	];
}

function buildContextProposalConfirmationLayout(
	title: string,
	proposal: ContextProposal,
): ContextProposalConfirmationLayout {
	return {
		title,
		intro: "Review the proposed mission, scope, constraints, and acceptance details before /cook writes canonical workflow state.",
		proposalHeading: "Proposed workflow",
		proposalBody: buildContextProposalDisplayText(proposal),
		actionsHeading: "Actions",
		actions: buildContextProposalConfirmationActions(),
		footer: "↑↓ navigate • enter select • esc cancel",
	};
}

function maybeWriteContextProposalConfirmationSnapshot(layout: ContextProposalConfirmationLayout): void {
	const snapshotPath = completionTestContextProposalUiSnapshotPath();
	if (!snapshotPath) return;
	try {
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(snapshotPath, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
	} catch {
		// ignore malformed or unwritable test snapshot paths
	}
}

function buildContextProposalConfirmationSelectItems(layout: ContextProposalConfirmationLayout): SelectItem[] {
	return layout.actions.map((action) => ({
		value: action.id,
		label: action.label,
		description: action.description,
	}));
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
		container.addChild(new Text(theme.fg("dim", layout.intro), 1, 0));
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("accent", theme.bold(layout.proposalHeading)), 1, 0));
		container.addChild(new Text(layout.proposalBody, 1, 0));
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("accent", theme.bold(layout.actionsHeading)), 1, 0));
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value as ContextProposalConfirmAction);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", layout.footer), 1, 0));
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

async function resolveEditedContextProposalDecision(
	ctx: { hasUI: boolean; ui: any },
	projectName: string,
	editedText: string,
	confirmMissionWhenNeeded: boolean,
): Promise<ContextProposalDecision | undefined> {
	if (!editedText.trim()) return undefined;
	const editedProposal = parseContextProposal(editedText, projectName);
	if (editedProposal) return { missionAnchor: editedProposal.mission, goalText: editedProposal.goalText };
	const assessment = assessMissionAnchor(editedText, projectName);
	if (!confirmMissionWhenNeeded) {
		return { missionAnchor: assessment.derived, goalText: editedText.trim() };
	}
	const missionAnchor = await confirmMissionAnchor(ctx, assessment);
	if (!missionAnchor) return undefined;
	return { missionAnchor, goalText: editedText.trim() };
}

async function resolveContextProposalConfirmationAction(
	ctx: { hasUI: boolean; ui: any },
	proposal: ContextProposal,
	projectName: string,
	options: ContextProposalConfirmOptions,
	action: ContextProposalConfirmAction,
	editedTextOverride?: string,
): Promise<ContextProposalDecision | undefined> {
	if (action === "cancel") return undefined;
	if (action === "start") {
		return { missionAnchor: proposal.mission, goalText: proposal.goalText };
	}
	const editedText =
		editedTextOverride ??
		(await getCtxUi(ctx)?.editor(
			options.editorPrompt ?? `${options.title}\n\nEdit the proposed mission, scope, constraints, and acceptance details below.`,
			buildContextProposalEditorText(proposal),
		));
	if (!editedText?.trim()) return undefined;
	return await resolveEditedContextProposalDecision(ctx, projectName, editedText, editedTextOverride === undefined);
}

function buildContextProposalEditorText(proposal: ContextProposal): string {
	return buildContextProposalGoalText(proposal);
}

function parseContextProposal(text: string, projectName: string): ContextProposal | undefined {
	const cleaned = stripCodeBlocks(text).replace(/\r/g, "").trim();
	if (!cleaned) return undefined;
	const lines = cleaned
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return undefined;

	let section: "mission" | "scope" | "constraints" | "acceptance" | undefined;
	let missionLine: string | undefined;
	const scope: string[] = [];
	const constraints: string[] = [];
	const acceptance: string[] = [];
	let structuredSignalCount = 0;

	for (const rawLine of lines) {
		const inlineSection = matchInlineProposalSection(rawLine);
		if (inlineSection) {
			section = inlineSection.section;
			structuredSignalCount += 1;
			if (inlineSection.section === "mission" && !missionLine) {
				missionLine = inlineSection.content;
			} else if (inlineSection.section === "constraints") {
				constraints.push(inlineSection.content);
			} else if (inlineSection.section === "acceptance") {
				acceptance.push(inlineSection.content);
			} else if (inlineSection.section === "scope") {
				scope.push(inlineSection.content);
			}
			continue;
		}
		const headerSection = detectProposalSection(rawLine);
		if (headerSection) {
			section = headerSection;
			structuredSignalCount += 1;
			continue;
		}
		const bullet = bulletText(rawLine);
		if (bullet) {
			structuredSignalCount += 1;
			if (section === "mission" && !missionLine) {
				missionLine = bullet;
				continue;
			}
			if (section === "constraints") {
				constraints.push(bullet);
				continue;
			}
			if (section === "acceptance") {
				acceptance.push(bullet);
				continue;
			}
			if (section === "scope") {
				scope.push(bullet);
				continue;
			}
			if (!missionLine) {
				missionLine = bullet;
				continue;
			}
			if (looksLikeAcceptance(bullet)) acceptance.push(bullet);
			else if (looksLikeConstraint(bullet)) constraints.push(bullet);
			else scope.push(bullet);
			continue;
		}
		const normalized = normalizeProposalLine(rawLine);
		if (!normalized) continue;
		if (!missionLine) {
			missionLine = normalized;
			continue;
		}
		if (section === "constraints" || looksLikeConstraint(normalized)) {
			constraints.push(normalized);
			continue;
		}
		if (section === "acceptance" || looksLikeAcceptance(normalized)) {
			acceptance.push(normalized);
			continue;
		}
		if (section === "scope") {
			scope.push(normalized);
		}
	}

	const basisPreview = cleaned.replace(/\s+/g, " ").trim();
	const missionSource = missionLine ?? scope[0] ?? acceptance[0] ?? constraints[0] ?? basisPreview;
	const assessment = assessMissionAnchor(missionSource, projectName);
	const normalizedMission = normalizeMissionAnchorText(missionSource);
	const itemCount = scope.length + constraints.length + acceptance.length;
	const hasStrongStructure = structuredSignalCount >= 2 || itemCount >= 2;
	if (!normalizedMission || isWeakMissionAnchor(normalizedMission)) return undefined;
	if (!hasStrongStructure && basisPreview.length < 140) return undefined;
	const mission = assessment.derived;
	const goalText = buildContextProposalGoalText({ mission, scope, constraints, acceptance });
	return {
		mission,
		scope,
		constraints,
		acceptance,
		goalText,
		basisPreview,
		source: "session",
	};
}

async function extractContextProposalFromSession(
	ctx: { cwd: string; hasUI: boolean; ui: any; sessionManager: any; model?: any; modelRegistry?: any },
	projectName: string,
	explicitGoal?: string,
): Promise<ContextProposal | undefined> {
	const recentEntries = collectRecentDiscussionEntries(ctx);
	return await analyzeContextProposalWithAgent(ctx, projectName, recentEntries, explicitGoal);
}

async function buildGoalAnchoredContextProposal(
	ctx: { cwd: string; hasUI: boolean; ui: any; sessionManager: any; model?: any; modelRegistry?: any },
	goal: string,
	projectName: string,
): Promise<ContextProposal> {
	const explicit = parseContextProposal(goal, projectName);
	const sessionProposal = await extractContextProposalFromSession(ctx, projectName, goal);
	const missionSource = explicit?.mission ?? goal;
	const assessment = assessMissionAnchor(missionSource, projectName);
	const mission = assessment.derived;
	const explicitScope = explicit?.scope ?? [];
	const sessionScope = (sessionProposal?.scope ?? []).filter((item) => isSessionScopeItemMissionRelevant(item, mission));
	const scope = uniqueProposalItems([...explicitScope, ...sessionScope]);
	const constraints = uniqueProposalItems([...(explicit?.constraints ?? []), ...(sessionProposal?.constraints ?? [])]);
	const acceptance = uniqueProposalItems([...(explicit?.acceptance ?? []), ...(sessionProposal?.acceptance ?? [])]);
	const goalText = buildContextProposalGoalText({ mission, scope, constraints, acceptance });
	return {
		mission,
		scope,
		constraints,
		acceptance,
		goalText,
		basisPreview: sessionProposal?.basisPreview ?? explicit?.basisPreview ?? goal,
		source: sessionProposal?.source ?? "session",
	};
}

async function confirmContextProposal(
	ctx: { hasUI: boolean; ui: any },
	proposal: ContextProposal,
	projectName: string,
	options: ContextProposalConfirmOptions,
): Promise<ContextProposalDecision | undefined> {
	const actionOverride = completionTestContextProposalActionOverride();
	if (actionOverride === "cancel") return undefined;
	if (actionOverride === "accept") {
		return { missionAnchor: proposal.mission, goalText: proposal.goalText };
	}
	if (actionOverride === "edit") {
		const editedText = completionTestContextProposalEditText();
		if (!editedText) return undefined;
		return await resolveEditedContextProposalDecision(ctx, projectName, editedText, false);
	}
	const layout = buildContextProposalConfirmationLayout(options.title, proposal);
	maybeWriteContextProposalConfirmationSnapshot(layout);
	const uiActionOverride = completionTestContextProposalUiActionOverride();
	if (uiActionOverride) {
		return await resolveContextProposalConfirmationAction(
			ctx,
			proposal,
			projectName,
			options,
			uiActionOverride,
			uiActionOverride === "edit" ? completionTestContextProposalEditText() : undefined,
		);
	}
	if (!getCtxHasUI(ctx)) {
		return options.nonInteractiveBehavior === "accept"
			? { missionAnchor: proposal.mission, goalText: proposal.goalText }
			: undefined;
	}
	const ui = getCtxUi(ctx);
	if (!ui) {
		return options.nonInteractiveBehavior === "accept"
			? { missionAnchor: proposal.mission, goalText: proposal.goalText }
			: undefined;
	}
	const choice = await promptContextProposalConfirmationAction(ui, layout);
	if (!choice) return undefined;
	return await resolveContextProposalConfirmationAction(ctx, proposal, projectName, options, choice);
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

function buildEvaluationRoleContextLines(snapshot: CompletionStateSnapshot, role: RubricEvaluationRole): string[] {
	const context = activeSliceContext(snapshot);
	const lines = [
		`Canonical evaluation handoff for ${role}:`,
		`- task_type: ${currentTaskType(snapshot) ?? "(missing)"}`,
		`- evaluation_profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`,
		`- latest_completed_slice: ${asString(snapshot.state?.latest_completed_slice) ?? "(none)"}`,
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
	];
	return lines;
}

function buildEvaluationRoleReminderText(snapshot: CompletionStateSnapshot, role: RubricEvaluationRole): string {
	return buildEvaluationRoleContextLines(snapshot, role).join(" ");
}

async function confirmExistingWorkflowGoal(
	ctx: { hasUI: boolean; ui: any },
	snapshot: CompletionStateSnapshot,
	goal: string,
): Promise<ExistingWorkflowDecision | undefined> {
	const currentMission = currentMissionAnchor(snapshot);
	const assessment = assessMissionAnchor(goal, path.basename(snapshot.files.root));
	const normalizedCurrent = normalizeMissionAnchorText(currentMission);
	const normalizedGoal = normalizeMissionAnchorText(goal);
	const normalizedProposed = normalizeMissionAnchorText(assessment.derived);
	if (!normalizedGoal || normalizedGoal === normalizedCurrent || normalizedProposed === normalizedCurrent) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const actionOverride = completionTestWorkflowActionOverride();
	if (actionOverride === "continue") {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	if (actionOverride === "refocus") {
		return { action: "refocus", currentMissionAnchor: currentMission, missionAnchor: assessment.derived };
	}
	if (!getCtxHasUI(ctx)) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const ui = getCtxUi(ctx);
	if (!ui) {
		return { action: "continue", currentMissionAnchor: currentMission };
	}
	const title = [
		"Existing completion workflow found",
		"",
		"A workflow is already in progress. Choose how /cook should proceed:",
		"",
		"Current mission",
		currentMission,
		"",
		"New proposed mission",
		assessment.derived,
	].join("\n");
	const continueChoice = "Continue current workflow\n\nKeep the current mission and treat the new goal as extra direction only.";
	const refocusChoice = "Abandon current workflow and start this new one\n\nReplace the current mission with the new goal, then rebuild canonical state from that new direction.";
	const cancelChoice = "Cancel\n\nExit without changing the current workflow.";
	const choice = await ui.select(title, [continueChoice, refocusChoice, cancelChoice]);
	if (!choice || choice === cancelChoice) return undefined;
	if (choice === refocusChoice) {
		const missionAnchor = await confirmMissionAnchor(ctx, assessment);
		if (!missionAnchor) return undefined;
		return { action: "refocus", currentMissionAnchor: currentMission, missionAnchor };
	}
	return { action: "continue", currentMissionAnchor: currentMission };
}

async function refocusCompletionMission(snapshot: CompletionStateSnapshot, missionAnchor: string, rawGoal: string): Promise<void> {
	const requiredStopJudges = asNumber(snapshot.profile?.required_stop_judges) ?? 3;
	const root = snapshot.files.root;
	const nextState = {
		...defaultState(missionAnchor),
		remaining_stop_judges: requiredStopJudges,
		continuation_reason: `User refocused workflow via /cook: ${truncateInline(rawGoal, 160)}`,
		next_mandatory_action: "Reconcile canonical state from current repo truth for the refocused mission",
	};
	const nextPlan = {
		...defaultPlan(missionAnchor),
		plan_basis: "user_refocus",
	};
	const nextActive = defaultActiveSlice(missionAnchor);
	await Promise.all([
		fsp.writeFile(path.join(snapshot.files.agentDir, "mission.md"), buildMission(path.basename(root), missionAnchor), "utf8"),
		writeJsonFile(snapshot.files.statePath, nextState),
		writeJsonFile(snapshot.files.planPath, nextPlan),
		writeJsonFile(snapshot.files.activePath, nextActive),
	]);
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

	if (mission.length > 120) {
		mission = `${mission.slice(0, 117).trimEnd()}...`;
	}

	if (!/[.!?。！？]$/u.test(mission)) mission += ".";
	return mission;
}

function defaultState(missionAnchor: string): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		current_phase: "reground",
		continuation_policy: "continue",
		continuation_reason: "Fresh completion bootstrap requires canonical re-ground",
		project_done: false,
		task_type: DEFAULT_TASK_TYPE,
		evaluation_profile: DEFAULT_EVALUATION_PROFILE,
		requires_reground: true,
		slices_since_last_reground: 0,
		remaining_release_blockers: null,
		remaining_high_value_gaps: null,
		unsatisfied_contract_ids: [],
		release_blocker_ids: [],
		next_mandatory_action: "Reconcile canonical state from current repo truth",
		next_mandatory_role: "completion-regrounder",
		remaining_stop_judges: 3,
		last_reground_at: null,
		last_auditor_verdict: null,
		contract_status: "unknown",
		latest_completed_slice: null,
		latest_verified_slice: null,
	};
}

function defaultPlan(missionAnchor: string): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		task_type: DEFAULT_TASK_TYPE,
		evaluation_profile: DEFAULT_EVALUATION_PROFILE,
		last_reground_at: null,
		plan_basis: "bootstrap",
		candidate_slices: [],
	};
}

function defaultActiveSlice(missionAnchor: string): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		task_type: DEFAULT_TASK_TYPE,
		evaluation_profile: DEFAULT_EVALUATION_PROFILE,
		status: "idle",
		slice_id: null,
		goal: null,
		contract_ids: [],
		acceptance_criteria: [],
		priority: null,
		why_now: null,
		blocked_on: [],
		locked_notes: [],
		must_fix_findings: [],
		implementation_surfaces: [],
		verification_commands: [],
		basis_commit: null,
		remaining_contract_ids_before: [],
		release_blocker_count_before: null,
		high_value_gap_count_before: null,
	};
}

function buildAgentReadme(projectName: string): string {
	return `# Completion Control Plane\n\nThis repository uses the \`completion\` workflow for long-running coding tasks.\n\n## Canonical tracked contract files\n\n- \`.agent/README.md\`\n- \`.agent/mission.md\`\n- \`.agent/profile.json\`\n- \`.agent/verify_completion_stop.sh\`\n- \`.agent/verify_completion_control_plane.sh\`\n\n## Ignored canonical execution state\n\n- \`.agent/state.json\`\n- \`.agent/plan.json\`\n- \`.agent/active-slice.json\`\n- \`.agent/slice-history.jsonl\`\n- \`.agent/stop-check-history.jsonl\`\n- \`.agent/*.log\`\n- \`.agent/tmp/\`\n\nThe source of truth for long-running completion work is canonical \`.agent/**\` state plus current repo truth.\n\nProject: ${projectName}\n`;
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
  .agent/active-slice.json; do
  [[ -e "$file" ]] || { echo "missing required file: $file"; exit 1; }
done

node <<'NODE'
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

for (const file of ['.agent/profile.json', '.agent/state.json', '.agent/plan.json', '.agent/active-slice.json']) {
  readJson(file);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');

assert(isObject(profile), '.agent/profile.json must be an object');
assert(isObject(state), '.agent/state.json must be an object');
assert(isObject(plan), '.agent/plan.json must be an object');
assert(isObject(active), '.agent/active-slice.json must be an object');

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
  hasOnlyKeys(slice, requiredSlice, label);
  assert(isString(slice.slice_id) && slice.slice_id.length > 0, label + ': slice_id must be a non-empty string');
  assert(isString(slice.goal) && slice.goal.length > 0, label + ': goal must be a non-empty string');
  assert(Array.isArray(slice.acceptance_criteria) && slice.acceptance_criteria.length > 0 && slice.acceptance_criteria.every((item) => typeof item === 'string' && item.length > 0), label + ': acceptance_criteria must be a non-empty array of strings');
  assert(isStringArray(slice.contract_ids), label + ': contract_ids must be an array of strings');
  assert(typeof slice.priority === 'number' && Number.isFinite(slice.priority), label + ': priority must be a finite number');
  assert(sliceStatuses.includes(slice.status), label + ': invalid status');
  assert(isString(slice.why_now) && slice.why_now.length > 0, label + ': why_now must be a non-empty string');
  assert(isStringArray(slice.blocked_on), label + ': blocked_on must be an array of strings');
  assert(isStringArray(slice.evidence), label + ': evidence must be an array of strings');
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
} else {
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

async function scaffoldCompletionFiles(root: string, missionAnchor: string): Promise<ScaffoldResult> {
	const files = resolveFiles(root);
	const created: string[] = [];
	const updated: string[] = [];
	await fsp.mkdir(files.agentDir, { recursive: true });
	await fsp.mkdir(path.join(files.agentDir, "tmp"), { recursive: true });
	const projectName = path.basename(root);
	const docsSurfaces = await detectDocsSurfaces(root);
	const verifierCommand = await detectVerifierCommand(root);
	const trackedFiles: Array<{ path: string; content: string; executable?: boolean }> = [
		{ path: path.join(files.agentDir, "README.md"), content: buildAgentReadme(projectName) },
		{ path: path.join(files.agentDir, "mission.md"), content: buildMission(projectName, missionAnchor) },
		{
			path: files.profilePath,
			content: `${JSON.stringify({ schema_version: 1, protocol_id: PROTOCOL_ID, project_name: projectName, required_stop_judges: 3, priority_policy_id: "completion-default", task_type: DEFAULT_TASK_TYPE, evaluation_profile: DEFAULT_EVALUATION_PROFILE, docs_surfaces: docsSurfaces }, null, 2)}\n`,
		},
		{ path: path.join(files.agentDir, "verify_completion_stop.sh"), content: buildVerifyStopScript(verifierCommand), executable: true },
		{ path: path.join(files.agentDir, "verify_completion_control_plane.sh"), content: buildVerifyControlPlaneScript(), executable: true },
		{ path: files.statePath, content: `${JSON.stringify(defaultState(missionAnchor), null, 2)}\n` },
		{ path: files.planPath, content: `${JSON.stringify(defaultPlan(missionAnchor), null, 2)}\n` },
		{ path: files.activePath, content: `${JSON.stringify(defaultActiveSlice(missionAnchor), null, 2)}\n` },
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

function activeSliceMatchesPlan(snapshot: CompletionStateSnapshot): "yes" | "no" | "unknown" {
	const activeId = asString(snapshot.active?.slice_id);
	if (!activeId) return "unknown";
	return snapshot.activeSlice ? "yes" : "no";
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
	return exactArrays.every((items) => items.length > 0) && required.every((value) => value !== undefined && value !== null)
		? "present"
		: "missing_or_unclear";
}

function buildSystemReminder(snapshot: CompletionStateSnapshot, sliceHistory: JsonRecord[], stopHistory: JsonRecord[]): string {
	const history = historyCounts(sliceHistory, stopHistory);
	const implementationSurfaces = asStringArray(snapshot.active?.implementation_surfaces);
	const verificationCommands = asStringArray(snapshot.active?.verification_commands);
	const activePriority = asNumber(snapshot.active?.priority);
	const activeWhyNow = asString(snapshot.active?.why_now);
	const nextRole = asString(snapshot.state?.next_mandatory_role);
	const lines = [
		"Completion workflow detected.",
		"Canonical truth lives in .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, and .agent/stop-check-history.jsonl.",
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
	if (activePriority !== undefined) lines.push(`Active slice priority: ${activePriority}`);
	if (activeWhyNow) lines.push(`Active slice why_now: ${activeWhyNow}`);
	if (implementationSurfaces.length > 0) lines.push(`Active implementation surfaces: ${implementationSurfaces.join(", ")}`);
	if (verificationCommands.length > 0) lines.push(`Active verification commands: ${verificationCommands.join(" | ")}`);
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
	const lines = [
		"POST-COMPACTION RECOVERY MODE is active.",
		`Compaction marker time: ${markerAt}`,
		"Treat the previous conversation as lossy continuity support only.",
		"Before taking any substantive action, re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, and .agent/stop-check-history.jsonl from disk.",
		`Canonical task_type is currently: ${taskType}`,
		`Canonical evaluation_profile is currently: ${evaluationProfile}`,
		`Canonical next mandatory role is currently: ${nextRole}`,
		`Canonical next mandatory action is currently: ${nextAction}`,
		`Canonical continuation policy is currently: ${continuation}`,
		`Canonical active slice is currently: ${activeSliceId}`,
		"Do not trust pre-compaction memory over canonical files.",
		"If the canonical state is ambiguous, inconsistent, missing, or stale after re-reading it, your first mandatory action is to dispatch completion-regrounder rather than guessing.",
		"If continuation_policy == continue and canonical state is coherent, continue dispatching the mandatory role directly without asking the user whether to continue.",
		"If you are about to implement after compaction, confirm the active slice snapshot still matches .agent/plan.json before doing any work.",
	];
	if (activePriority !== undefined) lines.push(`Canonical active-slice priority is currently: ${activePriority}`);
	if (activeWhyNow) lines.push(`Canonical active-slice why_now is currently: ${activeWhyNow}`);
	if (implementationSurfaces.length > 0) lines.push(`Canonical implementation surfaces are currently: ${implementationSurfaces.join(", ")}`);
	if (verificationCommands.length > 0) lines.push(`Canonical verification commands are currently: ${verificationCommands.join(" | ")}`);
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
		`implementer_handoff_snapshot: ${handoffSnapshotState(snapshot.active)}`,
		`history_counts: reviewed=${history.reviewed}, audited=${history.audited}, accepted=${history.accepted}, reopened=${history.reopened}, judgments=${history.judgments}`,
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
		"- Preserve exact slice_id, contract_ids, acceptance criteria, priority, why_now, implementation surfaces, verification commands, locked notes, and must-fix findings where still true.",
		"- After compaction, re-read .agent/state.json, .agent/plan.json, .agent/active-slice.json, .agent/slice-history.jsonl, and .agent/stop-check-history.jsonl before resuming long-running completion work.",
		"- Invoke completion-regrounder before continuing when requires_reground is true or unknown.",
		"- Invoke completion-regrounder before continuing when next_mandatory_role or next_mandatory_action is unknown or ambiguous.",
		"- Invoke completion-regrounder before continuing when active_slice_matches_plan is no or implementer_handoff_snapshot is missing_or_unclear.",
		"- If continuation_policy is continue, do not stop after a slice or ask whether to continue. Dispatch the next mandatory role directly.",
		"- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.",
		"- If you are completion-implementer after compaction, resume from the canonical active-slice handoff instead of asking the user to resend the original caller payload.",
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

function completionRootKey(snapshot: CompletionStateSnapshot | undefined, cwd: string): string {
	return snapshot?.files.root ?? findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? path.resolve(cwd);
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

function buildCompletionStatusSurface(
	snapshot: CompletionStateSnapshot | undefined,
	liveActivity: LiveRoleActivity | undefined,
): CompletionStatusSurface {
	if (!snapshot) return { snapshotPresent: false, widgetLines: [] };
	const currentPhase = asString(snapshot.state?.current_phase) ?? "unknown";
	const sliceId = asString(snapshot.active?.slice_id) ?? asString(snapshot.activeSlice?.slice_id) ?? "(none)";
	const sliceGoal = truncateInline(asString(snapshot.active?.goal) ?? asString(snapshot.activeSlice?.goal) ?? "(unknown)", 140);
	const nextMandatoryRole = asString(snapshot.state?.next_mandatory_role) ?? "unknown";
	const remainingContractCount = asStringArray(snapshot.state?.unsatisfied_contract_ids).length;
	const releaseBlockerCount = asNumber(snapshot.state?.remaining_release_blockers) ?? 0;
	const highValueGapCount = asNumber(snapshot.state?.remaining_high_value_gaps) ?? 0;
	const remainingStopJudgeCount = asNumber(snapshot.state?.remaining_stop_judges) ?? 0;
	const activeRole = liveActivity?.status === "running" ? liveActivity.role : undefined;
	const liveSignal = liveActivitySignal(liveActivity);
	const livePreview = livePreviewForStatus(liveActivity);
	const liveDetailsLines = activeRole
		? buildInlineRunningLines({
				role: activeRole,
				currentAction: liveActivity?.currentAction,
				toolActivity: liveActivity?.toolActivity,
				toolRecentActivity: liveActivity?.toolRecentActivity,
				recentActivity: liveActivity?.recentActivity,
				assistantSummary: liveActivity?.assistantSummary,
				progress: liveActivity?.progress,
				rationale: liveActivity?.rationale,
				nextStep: liveActivity?.nextStep,
				verifying: liveActivity?.verifying,
				stateDeltas: liveActivity?.stateDeltas,
				startedAt: liveActivity?.startedAt,
				updatedAt: liveActivity?.updatedAt,
		  })
		: [];
	const remainingSummary = completionRemainingSummary({
		remainingContractCount,
		releaseBlockerCount,
		highValueGapCount,
		remainingStopJudgeCount,
	});
	const widgetLines = activeRole
		? []
		: [
				"completion workflow",
				`phase: ${currentPhase}`,
				`slice: ${sliceId}`,
				`goal: ${sliceGoal}`,
				`next: ${nextMandatoryRole}`,
				`remaining: ${remainingSummary}`,
			];
	return {
		snapshotPresent: true,
		widgetLines,
		currentPhase,
		sliceId,
		nextMandatoryRole,
		remainingContractCount,
		releaseBlockerCount,
		highValueGapCount,
		remainingStopJudgeCount,
		activeRole,
		livePreview,
		liveState: liveSignal?.state,
		liveIdleMs: liveSignal?.idleMs,
		liveToolActivity: liveActivity?.toolActivity,
		liveAssistantSummary: liveActivity?.assistantSummary,
		liveProgress: liveActivity?.progress,
		liveRationale: liveActivity?.rationale,
		liveNextStep: liveActivity?.nextStep,
		liveVerifying: liveActivity?.verifying,
		liveStateDeltas: liveActivity?.stateDeltas ?? [],
		liveDetailsLines,
	};
}

async function writeCompletionStatusProbe(surface: CompletionStatusSurface): Promise<void> {
	const outputPath = asString(process.env.PI_COMPLETION_STATUS_SNAPSHOT_FILE);
	if (!outputPath) return;
	await fsp.mkdir(path.dirname(outputPath), { recursive: true });
	await fsp.writeFile(outputPath, `${JSON.stringify(surface, null, 2)}\n`, "utf8");
}

async function refreshStatus(ctx: { cwd: string; hasUI: boolean; ui: any }) {
	const snapshot = await loadCompletionSnapshot(getCtxCwd(ctx));
	const rootKey = completionRootKey(snapshot, getCtxCwd(ctx));
	maybeInjectTestLiveRoleActivity(rootKey);
	maybeReplayTestLiveRoleEvents(rootKey);
	const surface = buildCompletionStatusSurface(snapshot, liveRoleActivityByRoot.get(rootKey));
	await writeCompletionStatusProbe(surface);
	if (!getCtxHasUI(ctx)) return;
	const ui = getCtxUi(ctx);
	if (!ui) return;
	safeUiCall(() => {
		ui.setWidget(COMPLETION_STATUS_KEY, surface.widgetLines.length > 0 ? surface.widgetLines : undefined);
	});
}

function parseReportFields(text: string): Record<string, string> {
	return roleReporting.parseReportFields(text);
}

function parseYesNo(value: string | undefined): boolean | undefined {
	return roleReporting.parseYesNo(value);
}

function parseFirstNumber(value: string | undefined): number | undefined {
	return roleReporting.parseFirstNumber(value);
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

type TranscriptionResult = {
	appended: string[];
	skipped: string[];
	errors: string[];
};

async function appendJsonlRecord(filePath: string, record: JsonRecord): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
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

async function transcribeRoleOutput(role: CompletionRole, cwd: string, output: string, reportFields: Record<string, string>): Promise<TranscriptionResult> {
	const snapshot = await loadCompletionSnapshot(cwd);
	if (!snapshot) {
		return { appended: [], skipped: ["No canonical completion snapshot found."], errors: [] };
	}
	const headSha = await gitHeadSha(snapshot.files.root);
	if (!headSha) {
		return { appended: [], skipped: [], errors: ["Could not resolve git HEAD for transcription."] };
	}

	const sliceId =
		asString(snapshot.active?.slice_id) ??
		asString(snapshot.activeSlice?.slice_id) ??
		asString(snapshot.state?.latest_completed_slice);

	return await roleReporting.transcribeCanonicalRoleReport({
		role,
		output,
		reportFields,
		snapshotFiles: snapshot.files,
		headSha,
		sliceId,
	});
}

function isPathInside(root: string, candidatePath: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidatePath);
	return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveToolPath(cwd: string, rawPath: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function isAllowedControlPlanePath(root: string, rawPath: string): boolean {
	const resolved = resolveToolPath(root, rawPath);
	if (path.basename(resolved) === ".gitignore") return true;
	return isPathInside(path.join(root, ".agent"), resolved);
}

function startsWithAny(value: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => value.startsWith(prefix));
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function isMutatingBash(command: string): boolean {
	const normalized = normalizeCommand(command);
	return startsWithAny(normalized, [
		"git add",
		"git commit",
		"git push",
		"rm ",
		"mv ",
		"cp ",
		"mkdir ",
		"touch ",
		"chmod ",
		"chown ",
		"sed -i",
		"perl -pi",
		"python -c",
		"python3 -c",
		"node -e",
		"bun -e",
		"tee ",
	]) || normalized.includes(">") || normalized.includes("| tee") || normalized.includes("apply_patch");
}

async function loadAgentDefinition(cwd: string, role: CompletionRole): Promise<AgentDefinition> {
	const projectAgent = walkUpForDir(cwd, [".pi", "agents", `${role}.md`]);
	const packageAgent = PACKAGE_AGENTS_DIR ? path.join(PACKAGE_AGENTS_DIR, `${role}.md`) : undefined;
	const candidates = [projectAgent, packageAgent, path.join(AGENT_HOME, "agents", `${role}.md`)].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		const raw = await fsp.readFile(candidate, "utf8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(raw);
		return {
			name: frontmatter.name ?? role,
			description: frontmatter.description,
			tools: frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
			model: frontmatter.model,
			systemPrompt: body.trim(),
			filePath: candidate,
		};
	}
	throw new Error(`Missing completion agent definition for ${role}`);
}

async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	const filePath = path.join(dir, "prompt.md");
	await fsp.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
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
	return `/skill:completion-protocol Start or continue the completion workflow for this repo.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\nUser goal:\n${goal}\n\n${intentBlock}Driver instructions:\n- Canonical truth is in .agent/**. Re-read .agent/state.json, .agent/plan.json, and .agent/active-slice.json before acting when they exist.\n- If tracked completion contract files are missing or onboarding is required, invoke completion_role with role completion-bootstrapper.\n- Otherwise follow the mandatory dispatch rules from completion-protocol.\n- Use completion_role for all completion-* role work. Do not directly implement tracked product changes yourself.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
}

function completionResumePrompt(taskType: string, evaluationProfile: string): string {
	return `/skill:completion-protocol Resume the completion workflow from canonical state.\n\nBefore acting, read:\n- ${SKILL_PATH}\n- ${REFERENCE_PATH}\n\nCanonical routing profile:\n- task_type: ${taskType}\n- evaluation_profile: ${evaluationProfile}\n\nResume instructions:\n- Re-read .agent/state.json, .agent/plan.json, and .agent/active-slice.json before acting.\n- If canonical state is missing, invalid, contradictory, stale, or ambiguous, route to completion-regrounder first.\n- Continue from next_mandatory_role and next_mandatory_action.\n- Use completion_role for all completion-* role work.\n- Continue dispatching mandatory roles while continuation_policy == continue.\n- Only stop for the user when continuation_policy is await_user_input, blocked, paused, or done.`;
}

export default function completionExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await refreshStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const snapshot = await loadCompletionSnapshot(getCtxCwd(ctx));
		if (snapshot && (await pathExists(snapshot.files.compactionMarkerPath))) {
			await fsp.rm(snapshot.files.compactionMarkerPath, { force: true });
		}
		await refreshStatus(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const loaded = await loadCompletionDataForReminder(getCtxCwd(ctx));
		if (!loaded) return;
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
		const additions = [buildSystemReminder(loaded.snapshot, loaded.sliceHistory, loaded.stopHistory)];
		if (marker) additions.push(buildPostCompactionDriverInstructions(loaded.snapshot, marker));
		maybeWriteTestSnapshot(completionTestSystemReminderPath(), additions.join("\n\n"));
		const systemPrompt = getSystemPromptSafe(ctx);
		if (!systemPrompt) return;
		return {
			systemPrompt: `${systemPrompt}\n\n${additions.join("\n\n")}`,
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const loaded = await loadCompletionDataForReminder(getCtxCwd(ctx));
		if (!loaded) return;
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

		if (event.toolName === "completion_role" && role) {
			return { block: true, reason: `Nested completion role dispatch is forbidden for ${role}.` };
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const rawPath = asString((event.input as JsonRecord).path);
			if (!rawPath) return;

			if (role === "completion-reviewer" || role === "completion-auditor" || role === "completion-stop-judge") {
				return { block: true, reason: `${role} is read-only.` };
			}

			if ((role === "completion-bootstrapper" || role === "completion-regrounder") && !isAllowedControlPlanePath(root, rawPath)) {
				return { block: true, reason: `${role} may only edit .agent/** or .gitignore.` };
			}

			if (!role && completionActive && !isAllowedControlPlanePath(root, rawPath)) {
				return { block: true, reason: "The workflow driver may not edit tracked product files directly during completion." };
			}
		}

		if (event.toolName !== "bash") return;
		const command = asString((event.input as JsonRecord).command);
		if (!command) return;
		const normalized = normalizeCommand(command);

		if (["completion-reviewer", "completion-auditor", "completion-stop-judge"].includes(role ?? "") && isMutatingBash(normalized)) {
			return { block: true, reason: `${role} is read-only and cannot run mutating bash.` };
		}

		if ((role === "completion-bootstrapper" || role === "completion-regrounder") && startsWithAny(normalized, ["git add", "git commit"])) {
			return { block: true, reason: `${role} may not create commits.` };
		}

		if (!role && completionActive && startsWithAny(normalized, ["git add", "git commit"])) {
			return { block: true, reason: "The workflow driver may not create commits directly during completion." };
		}
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
			const agent = await loadAgentDefinition(runCwd, role);
			const loaded = await loadCompletionDataForReminder(runCwd);
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
			const systemPromptTemp = await writeTempFile("pi-completion-role-", agent.systemPrompt);
			const taskLines = [
				`Completion role: ${role}`,
				"Before acting, read the completion protocol skill and reference:",
				`- ${SKILL_PATH}`,
				`- ${REFERENCE_PATH}`,
				"Use canonical .agent/** state as the source of truth.",
			];
			if (loaded && isRubricEvaluationRole(role)) {
				taskLines.push("", ...buildEvaluationRoleContextLines(loaded.snapshot, role));
			}
			if (params.task?.trim()) {
				taskLines.push("", "Supplemental task context:", params.task.trim());
			}
			const prompt = taskLines.join("\n");
			const args: string[] = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPromptTemp.filePath];
			if (agent.model) args.push("--model", agent.model);
			if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
			args.push(prompt);

			const invocation = getPiInvocation(args);
			let stderr = "";
			const messages: RoleMessage[] = [];
			const liveActivity = createLiveRoleActivity(role);
			const emitRunningUpdate = (freshActivity = false) => {
				if (freshActivity) liveActivity.updatedAt = nowMs();
				const details: RunningDetails = {
					role,
					status: "running",
					currentAction: liveActivity.currentAction,
					toolActivity: liveActivity.toolActivity,
					toolRecentActivity: liveActivity.toolRecentActivity,
					recentActivity: liveActivity.recentActivity,
					assistantSummary: liveActivity.assistantSummary,
					lastAssistantText: liveActivity.lastAssistantText,
					progress: liveActivity.progress,
					rationale: liveActivity.rationale,
					nextStep: liveActivity.nextStep,
					verifying: liveActivity.verifying,
					stateDeltas: liveActivity.stateDeltas,
					startedAt: liveActivity.startedAt,
					updatedAt: liveActivity.updatedAt,
				};
				liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: "running" }));
				void refreshStatus(ctx as { cwd: string; hasUI: boolean; ui: any });
				onUpdate?.({
					content: [{ type: "text", text: liveActivity.lastAssistantText || liveActivity.currentAction || `Running ${role}...` }],
					details,
				});
			};
			emitRunningUpdate(true);
			const heartbeat = setInterval(() => emitRunningUpdate(false), LIVE_ROLE_HEARTBEAT_MS);

			try {
				const exitCode = await new Promise<number>((resolve) => {
					const proc = spawn(invocation.command, invocation.args, {
						cwd: runCwd,
						env: { ...process.env, PI_COMPLETION_ROLE: role },
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
					});
					let buffer = "";

					const processLine = (line: string) => {
						if (!line.trim()) return;
						try {
							const event = JSON.parse(line) as JsonRecord;
							if (applyLiveRoleEvent(liveActivity, event, messages)) emitRunningUpdate(true);
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
						if (buffer.trim()) processLine(buffer);
						resolve(code ?? 0);
					});

					proc.on("error", () => resolve(1));

					if (signal) {
						const abort = () => proc.kill("SIGTERM");
						if (signal.aborted) abort();
						else signal.addEventListener("abort", abort, { once: true });
					}
				});

				const output = liveActivity.lastAssistantText || stderr.trim() || `${role} finished with no text output.`;
				const reportFields = parseReportFields(output);
				const transcription = exitCode === 0 ? await transcribeRoleOutput(role, runCwd, output, reportFields) : undefined;
				if (transcription?.appended.length) {
					emitCommandText(ctx, `Completion transcription appended: ${transcription.appended.join(", ")}`, "info");
				}
				if (transcription?.errors.length) {
					emitCommandText(ctx, `Completion transcription warning: ${transcription.errors.join(" | ")}`, "warning");
				}
				liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: exitCode === 0 ? "ok" : "error" }));
				await refreshStatus(ctx as { cwd: string; hasUI: boolean; ui: any });
				return {
					content: [{ type: "text", text: output }],
					details: {
						role,
						status: exitCode === 0 ? "ok" : "error",
						exitCode,
						stderr: stderr.trim(),
						reportFields,
						transcription,
						currentAction: liveActivity.currentAction,
						toolActivity: liveActivity.toolActivity,
						toolRecentActivity: liveActivity.toolRecentActivity,
						recentActivity: liveActivity.recentActivity,
						assistantSummary: liveActivity.assistantSummary,
						lastAssistantText: liveActivity.lastAssistantText,
						progress: liveActivity.progress,
						rationale: liveActivity.rationale,
						nextStep: liveActivity.nextStep,
						verifying: liveActivity.verifying,
						stateDeltas: liveActivity.stateDeltas,
						startedAt: liveActivity.startedAt,
						updatedAt: liveActivity.updatedAt,
					},
					isError: exitCode !== 0,
				};
			} finally {
				clearInterval(heartbeat);
				setTimeout(() => {
					const current = liveRoleActivityByRoot.get(rootKey);
					if (current && current.role === role && current.status !== "running") {
						liveRoleActivityByRoot.delete(rootKey);
					}
				}, 10_000);
				await fsp.rm(systemPromptTemp.dir, { recursive: true, force: true });
			}
		},
		renderCall(args, theme) {
			const role = args.role || "completion-role";
			const task = typeof args.task === "string" ? args.task.trim() : "";
			let text = theme.fg("toolTitle", theme.bold("completion_role ")) + theme.fg("accent", role);
			if (task) {
				text += `\n${theme.fg("dim", task)}`;
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
						text += theme.fg(line.includes("stalled") ? "warning" : "dim", line);
						continue;
					}
					if (line === "recent tools:") {
						text += theme.fg("dim", line);
						continue;
					}
					if (line.startsWith("- ")) {
						text += `${theme.fg("muted", "- ")}${theme.fg("dim", line.slice(2))}`;
						continue;
					}
					text += theme.fg("dim", line);
				}
				return new Text(text, 0, 0);
			}
			const role = details.role ?? "completion-role";
			const ok = details.status === "ok" && !result.isError;
			let text = `${theme.fg(ok ? "success" : "error", ok ? "done" : "error")} ${theme.fg("toolTitle", theme.bold(role))}`;
			if (details.startedAt !== undefined) text += `\n${theme.fg("dim", `elapsed: ${formatElapsed(nowMs() - details.startedAt)}`)}`;
			if (details.toolActivity) text += `\n${theme.fg("toolOutput", `tool: ${details.toolActivity}`)}`;
			if (details.progress) text += `\n${theme.fg("toolOutput", `progress: ${details.progress}`)}`;
			else if (details.assistantSummary) text += `\n${theme.fg("dim", `assistant: ${details.assistantSummary}`)}`;
			if (details.rationale) text += `\n${theme.fg("dim", `rationale: ${details.rationale}`)}`;
			if (details.nextStep) text += `\n${theme.fg("dim", `next: ${details.nextStep}`)}`;
			if (details.verifying) text += `\n${theme.fg("dim", `verifying: ${details.verifying}`)}`;
			if (details.stateDeltas?.length) {
				for (const delta of details.stateDeltas.slice(-4)) text += `\n${theme.fg("dim", `state-delta: ${delta}`)}`;
			}
			if (details.transcription?.appended?.length) {
				text += `\n${theme.fg("success", `transcribed: ${details.transcription.appended.join(", ")}`)}`;
			}
			if (details.transcription?.skipped?.length && expanded) {
				text += `\n${theme.fg("dim", `skipped: ${details.transcription.skipped.join(" | ")}`)}`;
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
				text += `\n${theme.fg("dim", `${key}: `)}${value}`;
			}
			const body = result.content.find((item) => item.type === "text");
			if (expanded && body?.type === "text") {
				text += `\n\n${body.text}`;
			} else if (!expanded && body?.type === "text") {
				const preview = body.text.split("\n").slice(0, 4).join("\n");
				text += `\n${theme.fg("dim", preview)}`;
			}
			if (details.stderr && expanded) text += `\n${theme.fg("error", details.stderr)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("cook", {
		description: "Start or continue the completion workflow for a repo",
		handler: async (args, ctx) => {
			const explicitGoal = args.trim();
			let goal = explicitGoal;
			const cwd = getCtxCwd(ctx);
			let snapshot = await loadCompletionSnapshot(cwd);
			const hadSnapshot = Boolean(snapshot);
			const workflowDone = isWorkflowDone(snapshot);
			let kickoffIntent: "auto" | "continue" | "refocus" = "auto";
			let kickoffMissionAnchor = snapshot ? currentMissionAnchor(snapshot) : undefined;

			if (!snapshot) {
				const root = findRepoRoot(cwd) ?? cwd;
				const projectName = path.basename(root);
				if (!goal) {
					const proposal = await extractContextProposalFromSession(ctx, projectName);
					if (!proposal) {
						emitCommandText(
							ctx,
							"Usage: /cook <goal> (discussion-only startup needs proposal analyst output; otherwise pass an explicit goal)",
							"error",
						);
						return;
					}
					const decision = await confirmContextProposal(ctx, proposal, projectName, {
						title: "Start a completion workflow from the recent discussion?",
						editorPrompt:
							"Start a completion workflow from the recent discussion?\n\nEdit the proposed mission, scope, constraints, and acceptance details below.",
					});
					if (!decision) {
						emitCommandText(ctx, "Cancelled recent-discussion workflow proposal", "info");
						return;
					}
					goal = decision.goalText;
					kickoffMissionAnchor = decision.missionAnchor;
				} else {
					const proposal = await buildGoalAnchoredContextProposal(ctx, goal, projectName);
					const decision = await confirmContextProposal(ctx, proposal, projectName, {
						title: "Start a completion workflow from this goal?",
						nonInteractiveBehavior: "accept",
						editorPrompt:
							"Start a completion workflow from this goal?\n\nEdit the proposed mission, scope, constraints, and acceptance details below.",
					});
					if (!decision) {
						emitCommandText(ctx, "Cancelled workflow startup proposal", "info");
						return;
					}
					goal = decision.goalText;
					kickoffMissionAnchor = decision.missionAnchor;
				}
				const created = await scaffoldCompletionFiles(root, kickoffMissionAnchor ?? projectName);
				emitCommandText(
					ctx,
					`Initialized completion control plane in ${created.root}${created.created.length > 0 ? ` (${created.created.length} files created)` : ""}`,
					"info",
				);
				snapshot = await loadCompletionSnapshot(root);
			}
			if (!snapshot) {
				emitCommandText(ctx, "Failed to load completion workflow state", "error");
				return;
			}
			if (!goal) {
				if (workflowDone) {
					const projectName = path.basename(snapshot.files.root);
					const proposal = await extractContextProposalFromSession(ctx, projectName);
					if (!proposal) {
						emitCommandText(
							ctx,
							"The previous completion workflow is already done. Provide /cook <goal>, or rerun /cook when the proposal analyst can summarize the next round from discussion.",
							"info",
						);
						return;
					}
					const decision = await confirmContextProposal(ctx, proposal, projectName, {
						title: "The previous completion workflow is done. Start the next workflow round from the recent discussion?",
						editorPrompt:
							"The previous completion workflow is done. Start the next workflow round from the recent discussion?\n\nEdit the proposed mission, scope, constraints, and acceptance details below.",
					});
					if (!decision) {
						emitCommandText(ctx, "Cancelled next workflow round proposal", "info");
						return;
					}
					goal = decision.goalText;
					kickoffIntent = "refocus";
					kickoffMissionAnchor = decision.missionAnchor;
					await refocusCompletionMission(snapshot, decision.missionAnchor, decision.goalText);
					snapshot = (await loadCompletionSnapshot(snapshot.files.root)) ?? snapshot;
					emitCommandText(ctx, `Started a new completion workflow round from recent discussion: ${decision.missionAnchor}`, "info");
				} else {
					const mission = currentMissionAnchor(snapshot);
					pi.setSessionName(`completion: ${mission.slice(0, 60)}`);
					const resumePrompt = completionResumePrompt(
						currentTaskType(snapshot) ?? "(missing)",
						currentEvaluationProfile(snapshot) ?? "(missing)",
					);
					maybeWriteTestSnapshot(completionTestDriverPromptPath(), `${resumePrompt}\n`);
					if (shouldSkipDriverKickoffForTests()) {
						emitCommandText(ctx, "Skipped completion workflow resume kickoff (test mode)", "info");
						return;
					}
					pi.sendUserMessage(resumePrompt);
					emitCommandText(ctx, "Queued completion workflow resume", "info");
					return;
				}
			}
			kickoffMissionAnchor = kickoffMissionAnchor ?? currentMissionAnchor(snapshot);
			if (hadSnapshot && explicitGoal) {
				if (workflowDone) {
					const projectName = path.basename(snapshot.files.root);
					const proposal = await buildGoalAnchoredContextProposal(ctx, goal, projectName);
					const decision = await confirmContextProposal(ctx, proposal, projectName, {
						title: "Start the next workflow round from this goal?",
						nonInteractiveBehavior: "accept",
						editorPrompt:
							"Start the next workflow round from this goal?\n\nEdit the proposed mission, scope, constraints, and acceptance details below.",
					});
					if (!decision) {
						emitCommandText(ctx, "Cancelled next workflow round proposal", "info");
						return;
					}
					goal = decision.goalText;
					kickoffIntent = "refocus";
					kickoffMissionAnchor = decision.missionAnchor;
					await refocusCompletionMission(snapshot, decision.missionAnchor, decision.goalText);
					snapshot = (await loadCompletionSnapshot(snapshot.files.root)) ?? snapshot;
					emitCommandText(ctx, `Started a new completion workflow round from explicit goal: ${decision.missionAnchor}`, "info");
				} else {
					const decision = await confirmExistingWorkflowGoal(ctx, snapshot, goal);
					if (!decision) {
						emitCommandText(ctx, "Cancelled existing workflow confirmation", "info");
						return;
					}
					kickoffIntent = decision.action;
					kickoffMissionAnchor = decision.currentMissionAnchor;
					if (decision.action === "refocus") {
						const projectName = path.basename(snapshot.files.root);
						const proposal = await buildGoalAnchoredContextProposal(ctx, goal, projectName);
						const proposalDecision = await confirmContextProposal(ctx, proposal, projectName, {
							title: "Start the replacement workflow from this goal?",
							nonInteractiveBehavior: "accept",
							editorPrompt:
								"Start the replacement workflow from this goal?\n\nEdit the proposed mission, scope, constraints, and acceptance details below.",
						});
						if (!proposalDecision) {
							emitCommandText(ctx, "Cancelled replacement workflow proposal", "info");
							return;
						}
						goal = proposalDecision.goalText;
						await refocusCompletionMission(snapshot, proposalDecision.missionAnchor, proposalDecision.goalText);
						snapshot = (await loadCompletionSnapshot(snapshot.files.root)) ?? snapshot;
						kickoffMissionAnchor = proposalDecision.missionAnchor;
						emitCommandText(ctx, `Refocused completion mission to: ${proposalDecision.missionAnchor}`, "info");
					} else if (normalizeMissionAnchorText(goal) !== normalizeMissionAnchorText(decision.currentMissionAnchor)) {
						emitCommandText(ctx, `Continuing existing workflow without changing mission anchor: ${decision.currentMissionAnchor}`, "info");
					}
				}
			}
			pi.setSessionName(`completion: ${kickoffMissionAnchor.slice(0, 60)}`);
			const kickoffPrompt = completionKickoff(
				goal,
				currentTaskType(snapshot) ?? "(missing)",
				currentEvaluationProfile(snapshot) ?? "(missing)",
				kickoffIntent,
				kickoffMissionAnchor,
			);
			maybeWriteTestSnapshot(completionTestDriverPromptPath(), `${kickoffPrompt}\n`);
			if (shouldSkipDriverKickoffForTests()) {
				emitCommandText(ctx, "Skipped completion workflow kickoff (test mode)", "info");
				return;
			}
			pi.sendUserMessage(kickoffPrompt);
			emitCommandText(ctx, "Queued completion workflow kickoff", "info");
		},
	});
}
