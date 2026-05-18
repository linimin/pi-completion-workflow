import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DynamicBorder, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	buildContextProposalAnalystPromptFromEntries,
	extractJsonObjectFromText,
	parseContextProposalAnalystOutput,
	serializeRecentDiscussionEntries,
	type ContextProposal,
	type RecentDiscussionEntry,
} from "./proposal";
import {
	buildCookTriggerClassifierPrompt,
	contextProposalAnalystProgressLines,
	maybeWriteCookTriggerClassifierSnapshot,
} from "./prompt-surfaces";
import {
	applyLiveRoleEvent,
	buildInlineRunningLines,
	cloneLiveRoleActivity,
	createLiveRoleActivity,
	formatInlineRunningText,
	nowMs,
	pushRecentActivity,
	refreshCompletionStatus,
	type RoleMessage,
} from "./status-surface";
import { completionRootKey, findCompletionRoot, findRepoRoot, loadCompletionDataForReminder } from "./state-store";
import { parseReportFields, transcribeRoleOutput, type TranscriptionResult } from "./transcription";
import type {
	AgentDefinition,
	CompletionRole,
	CookTriggerClassification,
	JsonRecord,
	LiveRoleActivity,
} from "./types";

export type RunCompletionRoleParams = {
	root: string;
	role: CompletionRole;
	task?: string;
	signal?: AbortSignal;
	systemPromptPreamble: string[];
	evaluationContextLines?: string[];
	onUpdate?: (activity: LiveRoleActivity) => void;
	onConsoleMessage?: (level: "info" | "warning", text: string) => void;
	createLiveRoleActivity: (role: string) => LiveRoleActivity;
	cloneLiveRoleActivity: (activity: LiveRoleActivity, overrides?: Partial<LiveRoleActivity>) => LiveRoleActivity;
	applyLiveRoleEvent: (activity: LiveRoleActivity, event: JsonRecord, messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>) => boolean;
	nowMs: () => number;
	heartbeatMs: number;
};

export type RunCompletionRoleResult = {
	role: CompletionRole;
	ok: boolean;
	exitCode: number;
	output: string;
	stderr?: string;
	reportFields: Record<string, string>;
	transcription?: TranscriptionResult;
	activity: LiveRoleActivity;
};

export type AnalyzeContextProposalWithAgentParams = {
	ctx: { cwd: string; hasUI: boolean; ui: any; model?: any };
	projectName: string;
	recentEntries: RecentDiscussionEntry[];
	workflowContextLines?: string[];
	liveRoleActivityByRoot: Map<string, LiveRoleActivity>;
	completionStatusKey: string;
	safeUiCall: (action: () => void) => void;
	getCtxCwd: (ctx: { cwd: string }) => string;
	getCtxHasUI: (ctx: { hasUI: boolean }) => boolean;
	getCtxUi: <T extends { ui: any }>(ctx: T) => any | undefined;
};

export type ClassifyCookTriggerIntentWithAgentParams = {
	ctx: { cwd: string; hasUI: boolean; ui: any; model?: any };
	projectName: string;
	inputText: string;
	recentEntries: RecentDiscussionEntry[];
	workflowContextLines?: string[];
};

export type CookTriggerClassifierResult = {
	status: "classified" | "timeout" | "invalid_output" | "error";
	classification?: CookTriggerClassification;
	rawOutput?: string;
	errorMessage?: string;
};

const AGENT_HOME = path.join(os.homedir(), ".pi", "agent");
const EXTENSION_DIR = typeof __dirname === "string" ? __dirname : process.cwd();
const PACKAGE_ROOT_CANDIDATE = path.resolve(EXTENSION_DIR, "..", "..");
const PACKAGE_ROOT = fs.existsSync(path.join(PACKAGE_ROOT_CANDIDATE, "package.json")) ? PACKAGE_ROOT_CANDIDATE : undefined;
const PACKAGE_AGENTS_DIR = PACKAGE_ROOT ? path.join(PACKAGE_ROOT, "agents") : undefined;
const CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT = [
	"You analyze recent /cook startup discussion and return a strict JSON object.",
	"Do not emit markdown, code fences, or commentary.",
	"Return exactly one JSON object with keys: mission, scope, constraints, acceptance, critique, risks, task_type, evaluation_profile, confidence, possible_noise.",
	"You may additionally include optional keys alternate_missions, completed_topics, and negated_topics when they are clearly supported by the discussion and canonical workflow context.",
	"mission must be a concise implementation mission anchor sentence.",
	"Prefer the latest clear user implementation intent over older background context when they differ.",
	"If canonical workflow context includes a /cook hint, treat it as a high-priority disambiguation signal, but do not let it bypass clear contradictory repo truth or approval-only confirmation.",
	"Do not reopen work that the canonical workflow context says is done, completed, historical, or already covered unless the latest discussion clearly asks to revisit it.",
	"Treat stale, weakly related, or explicitly negated topics as noise instead of mission scope.",
	"scope must contain only work items that directly support the mission.",
	"constraints must contain guardrails or non-goals explicitly stated or strongly implied by the discussion.",
	"acceptance must contain verifiable outcomes explicitly stated or strongly implied by the discussion.",
	"critique must contain operator-facing cautions, concerns, or reminders that should be shown separately from mission and scope later.",
	"risks must contain concrete failure modes or regressions that the later workflow should keep in view.",
	"task_type and evaluation_profile should be candidate routing hints only; reuse the existing completion vocabulary when it clearly fits instead of inventing new schema names.",
	"possible_noise should list discussion points that look stale, weakly related, unsafe to promote into scope, or already completed elsewhere.",
	"When discussion is insufficient, prefer empty arrays and a low confidence value over invention.",
].join(" ");
const STARTUP_ANALYST_ROLE = "cook-proposal-analyst";
const ANALYST_HEARTBEAT_MS = 5_000;
const COOK_TRIGGER_CLASSIFIER_SYSTEM_PROMPT = [
	"You classify whether the latest user input should hand control to the canonical /cook workflow before the primary agent starts implementation work.",
	"Do not emit markdown, code fences, or commentary.",
	"Return exactly one JSON object with keys: decision, confidence, workflow_bias, reason, evidence, riskFlags, focusHint.",
	"decision must be exactly one of offer_workflow, normal_prompt, or unclear.",
	"Use offer_workflow only when the latest input is handing control from discussion into workflow execution or explicitly asking to let /cook take over.",
	"Use normal_prompt for ordinary questions, explanations, or direct requests that should stay with the primary agent.",
	"Use unclear for ambiguous approvals, acknowledgements, or mixed signals where false-positive routing risk is material.",
	"workflow_bias must be exactly one of startup, resume, refocus, next_round, or unknown.",
	"Use startup when there is no active workflow yet, resume when the user is clearly continuing the current workflow, refocus when the user is clearly switching the active workflow to a different goal, and next_round when the previous workflow is done and the user is starting a new round.",
	"When decision is not offer_workflow, prefer workflow_bias=unknown unless a stronger routing hint would still aid debugging.",
	"confidence must be a number from 0 to 1.",
	"reason must be a single concise sentence.",
	"evidence must be an array of short grounded strings.",
	"riskFlags must be an array of short machine-readable strings such as ambiguous-approval, possible-normal-agent-request, or active-workflow-refocus-risk.",
	"focusHint is optional, must stay short, and must never rewrite the workflow mission or invent scope.",
	"Short acknowledgements like 好, 可以, ok, sure, or 那就這樣 should usually be unclear unless the surrounding context makes the handoff explicit.",
].join(" ");
const COOK_TRIGGER_CLASSIFIER_TIMEOUT_MS = 10_000;

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
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function contextProposalAnalystModelArg(model: unknown): string | undefined {
	if (!isRecord(model)) return undefined;
	const provider = asString(model.provider);
	const id = asString(model.id);
	return provider && id ? `${provider}/${id}` : undefined;
}

async function runContextProposalAnalystSubprocess(params: AnalyzeContextProposalWithAgentParams): Promise<string | undefined> {
	const { ctx, projectName, recentEntries } = params;
	const modelArg = contextProposalAnalystModelArg(ctx.model);
	if (!modelArg) return undefined;
	const cwd = params.getCtxCwd(ctx);
	const runCwd = findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? cwd;
	const rootKey = completionRootKey(undefined, cwd);
	const prompt = buildContextProposalAnalystPromptFromEntries(projectName, recentEntries, params.workflowContextLines);
	const systemPromptTemp = await writeTempFile(runCwd, "pi-cook-proposal-analyst-", CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT);
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--append-system-prompt", systemPromptTemp.filePath, "--model", modelArg, prompt];
	const invocation = getPiInvocation(args);
	const liveActivity = createLiveRoleActivity(STARTUP_ANALYST_ROLE);
	liveActivity.progress = "Analyzing recent discussion";
	liveActivity.currentAction = "Reading recent discussion and preparing a startup proposal";
	liveActivity.assistantSummary = liveActivity.progress;
	liveActivity.recentActivity = pushRecentActivity(liveActivity.recentActivity, `assistant: ${liveActivity.progress}`);
	const messages: RoleMessage[] = [];
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
		params.liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: "running" }));
		void refreshCompletionStatus({
			ctx,
			liveRoleActivityByRoot: params.liveRoleActivityByRoot,
			completionStatusKey: params.completionStatusKey,
			safeUiCall: params.safeUiCall,
			getCtxCwd: params.getCtxCwd,
			getCtxHasUI: params.getCtxHasUI,
			getCtxUi: params.getCtxUi,
		});
		overlay?.setLines(contextProposalAnalystProgressLines(liveActivity, buildInlineRunningLines));
	};
	const heartbeat = setInterval(() => updateActivity(false), ANALYST_HEARTBEAT_MS);
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
				proc.stderr.on("data", (_chunk) => {
					// ignore analyst stderr unless the subprocess exits without assistant output
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
			params.liveRoleActivityByRoot.set(rootKey, cloneLiveRoleActivity(liveActivity, { status: output ? "ok" : "error" }));
			await refreshCompletionStatus({
				ctx,
				liveRoleActivityByRoot: params.liveRoleActivityByRoot,
				completionStatusKey: params.completionStatusKey,
				safeUiCall: params.safeUiCall,
				getCtxCwd: params.getCtxCwd,
				getCtxHasUI: params.getCtxHasUI,
				getCtxUi: params.getCtxUi,
			});
			return output;
		} finally {
			clearInterval(heartbeat);
			setTimeout(() => {
				const current = params.liveRoleActivityByRoot.get(rootKey);
				if (current && current.role === STARTUP_ANALYST_ROLE && current.status !== "running") {
					params.liveRoleActivityByRoot.delete(rootKey);
					void refreshCompletionStatus({
						ctx,
						liveRoleActivityByRoot: params.liveRoleActivityByRoot,
						completionStatusKey: params.completionStatusKey,
						safeUiCall: params.safeUiCall,
						getCtxCwd: params.getCtxCwd,
						getCtxHasUI: params.getCtxHasUI,
						getCtxUi: params.getCtxUi,
					});
				}
			}, 10_000);
			await fsp.rm(systemPromptTemp.dir, { recursive: true, force: true });
		}
	};
	if (params.getCtxHasUI(ctx)) {
		const ui = params.getCtxUi(ctx);
		if (ui) {
			return await ui.custom<string | undefined>((_tui, theme, _kb, done) => {
				finishOverlay = done;
				overlay = new StartupAnalystOverlay(theme);
				overlay.setLines(contextProposalAnalystProgressLines(liveActivity, buildInlineRunningLines));
				run().then(settleOverlay).catch(() => settleOverlay(undefined));
				return overlay;
			});
		}
	}
	return await run();
}

export async function analyzeContextProposalWithAgent(params: AnalyzeContextProposalWithAgentParams): Promise<ContextProposal | undefined> {
	if (process.env.PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST === "1") return undefined;
	const testOutput = asString(process.env.PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT);
	if (testOutput) return parseContextProposalAnalystOutput(testOutput, params.projectName);
	if (params.recentEntries.length === 0) return undefined;
	try {
		const raw = await runContextProposalAnalystSubprocess(params);
		if (!raw) return undefined;
		return parseContextProposalAnalystOutput(raw, params.projectName);
	} catch (error) {
		console.warn("[completion] context proposal analyst failed", error);
		return undefined;
	}
}

function uniqueStrings(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of items) {
		const normalized = item.trim();
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function localAsStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? uniqueStrings(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))
		: [];
}

function confidenceFromUnknown(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim().length > 0
				? Number.parseFloat(value)
				: Number.NaN;
	if (!Number.isFinite(parsed)) return 0;
	return Math.min(1, Math.max(0, parsed));
}

function parseCookTriggerClassification(raw: string): CookTriggerClassification | undefined {
	const jsonText = extractJsonObjectFromText(raw);
	if (!jsonText) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const rawDecision = asString(parsed.decision ?? parsed.intent);
	const decision =
		rawDecision === "offer_workflow" || rawDecision === "normal_prompt" || rawDecision === "unclear"
			? rawDecision
			: rawDecision === "route_to_cook"
				? "offer_workflow"
				: undefined;
	if (!decision) return undefined;
	const rawWorkflowBias = asString(parsed.workflow_bias ?? parsed.workflowBias ?? parsed.routing_bias ?? parsed.routingBias);
	const workflowBias =
		rawWorkflowBias === "startup" ||
		rawWorkflowBias === "resume" ||
		rawWorkflowBias === "refocus" ||
		rawWorkflowBias === "next_round" ||
		rawWorkflowBias === "unknown"
			? rawWorkflowBias
			: decision === "offer_workflow" && rawDecision === "route_to_cook"
				? "unknown"
				: "unknown";
	const evidence = localAsStringArray(parsed.evidence);
	const riskFlags = localAsStringArray(parsed.riskFlags ?? parsed.risk_flags);
	const reason = asString(parsed.reason) ?? asString(parsed.rationale) ?? evidence[0] ?? `Classifier returned ${decision}.`;
	const focusHint = asString(parsed.focusHint ?? parsed.focus_hint);
	return {
		decision,
		confidence: confidenceFromUnknown(parsed.confidence),
		workflowBias,
		reason,
		focusHint,
		evidence: evidence.length > 0 ? evidence : [reason],
		riskFlags,
	};
}

function triggerClassifierFailureModeFromEnv(): "timeout" | "error" | "invalid_output" | undefined {
	const raw = asString(process.env.PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_FAILURE)?.toLowerCase();
	return raw === "timeout" || raw === "error" || raw === "invalid_output" ? raw : undefined;
}

function triggerClassifierSnapshotPath(): string | undefined {
	return asString(process.env.PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH);
}

async function runCookTriggerClassifierSubprocess(
	params: ClassifyCookTriggerIntentWithAgentParams & { prompt: string },
): Promise<CookTriggerClassifierResult> {
	const cwd = params.ctx.cwd;
	const runCwd = findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? cwd;
	const modelArg = contextProposalAnalystModelArg(params.ctx.model);
	const systemPromptTemp = await writeTempFile(runCwd, "pi-cook-trigger-classifier-", COOK_TRIGGER_CLASSIFIER_SYSTEM_PROMPT);
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--append-system-prompt", systemPromptTemp.filePath];
	if (modelArg) args.push("--model", modelArg);
	args.push(params.prompt);
	const invocation = getPiInvocation(args);
	const liveActivity = createLiveRoleActivity("cook-trigger-classifier");
	const messages: RoleMessage[] = [];
	let stderr = "";
	let timedOut = false;
	try {
		const rawOutput = await new Promise<string | undefined>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: runCwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let settled = false;
			let buffer = "";
			const resolveOnce = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				resolveOnce(undefined);
			}, COOK_TRIGGER_CLASSIFIER_TIMEOUT_MS);
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as JsonRecord;
					applyLiveRoleEvent(liveActivity, event, messages);
				} catch {
					// ignore malformed lines from the subprocess event stream
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
				clearTimeout(timeoutHandle);
				if (buffer.trim()) processLine(buffer);
				if (timedOut) return;
				resolveOnce(code === 0 ? liveActivity.lastAssistantText?.trim() || undefined : undefined);
			});
			proc.on("error", () => {
				clearTimeout(timeoutHandle);
				resolveOnce(undefined);
			});
		});
		if (!rawOutput) {
			if (timedOut) {
				return {
					status: "timeout",
					errorMessage: `Trigger classifier timed out after ${COOK_TRIGGER_CLASSIFIER_TIMEOUT_MS}ms.`,
				};
			}
			return { status: "error", errorMessage: stderr.trim() || "Trigger classifier produced no assistant output." };
		}
		const classification = parseCookTriggerClassification(rawOutput);
		if (!classification) {
			return {
				status: "invalid_output",
				rawOutput,
				errorMessage: "Trigger classifier returned invalid JSON output.",
			};
		}
		return { status: "classified", classification, rawOutput };
	} finally {
		await fsp.rm(systemPromptTemp.dir, { recursive: true, force: true });
	}
}

export async function classifyCookTriggerIntentWithAgent(
	params: ClassifyCookTriggerIntentWithAgentParams,
): Promise<CookTriggerClassifierResult> {
	const recentDiscussion = serializeRecentDiscussionEntries(params.recentEntries);
	const prompt = buildCookTriggerClassifierPrompt({
		projectName: params.projectName,
		inputText: params.inputText,
		recentDiscussion,
		workflowContextLines: params.workflowContextLines,
	});
	const snapshotPath = triggerClassifierSnapshotPath();
	const testFailureMode = triggerClassifierFailureModeFromEnv();
	if (testFailureMode) {
		const result: CookTriggerClassifierResult = {
			status: testFailureMode,
			errorMessage: `Forced trigger classifier ${testFailureMode} for deterministic tests.`,
		};
		maybeWriteCookTriggerClassifierSnapshot(
			{
				projectName: params.projectName,
				inputText: params.inputText,
				recentEntries: params.recentEntries,
				workflowContextLines: params.workflowContextLines ?? [],
				prompt,
				result,
			},
			snapshotPath,
		);
		return result;
	}
	const testOutput = asString(process.env.PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT);
	if (testOutput) {
		const classification = parseCookTriggerClassification(testOutput);
		const result: CookTriggerClassifierResult = classification
			? { status: "classified", classification, rawOutput: testOutput }
			: {
				status: "invalid_output",
				rawOutput: testOutput,
				errorMessage: "Trigger classifier test override did not match the required JSON schema.",
			};
		maybeWriteCookTriggerClassifierSnapshot(
			{
				projectName: params.projectName,
				inputText: params.inputText,
				recentEntries: params.recentEntries,
				workflowContextLines: params.workflowContextLines ?? [],
				prompt,
				result,
			},
			snapshotPath,
		);
		return result;
	}
	try {
		const result = await runCookTriggerClassifierSubprocess({ ...params, prompt });
		maybeWriteCookTriggerClassifierSnapshot(
			{
				projectName: params.projectName,
				inputText: params.inputText,
				recentEntries: params.recentEntries,
				workflowContextLines: params.workflowContextLines ?? [],
				prompt,
				result,
			},
			snapshotPath,
		);
		return result;
	} catch (error) {
		const result: CookTriggerClassifierResult = {
			status: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
		maybeWriteCookTriggerClassifierSnapshot(
			{
				projectName: params.projectName,
				inputText: params.inputText,
				recentEntries: params.recentEntries,
				workflowContextLines: params.workflowContextLines ?? [],
				prompt,
				result,
			},
			snapshotPath,
		);
		return result;
	}
}

export async function loadAgentDefinition(cwd: string, role: CompletionRole): Promise<AgentDefinition> {
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

export async function writeTempFile(root: string, prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
	const agentTmpRoot = path.join(root, ".agent", "tmp");
	try {
		await fsp.mkdir(agentTmpRoot, { recursive: true });
		const dir = await fsp.mkdtemp(path.join(agentTmpRoot, prefix));
		const filePath = path.join(dir, "prompt.md");
		await fsp.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
		return { dir, filePath };
	} catch {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
		const filePath = path.join(dir, "prompt.md");
		await fsp.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
		return { dir, filePath };
	}
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

export async function runCompletionRole(params: RunCompletionRoleParams): Promise<RunCompletionRoleResult> {
	const agent = await loadAgentDefinition(params.root, params.role);
	await loadCompletionDataForReminder(params.root);
	const systemPromptTemp = await writeTempFile(params.root, "pi-completion-role-", agent.systemPrompt);
	const taskLines = [...params.systemPromptPreamble];
	if (params.evaluationContextLines?.length) taskLines.push("", ...params.evaluationContextLines);
	if (params.task?.trim()) taskLines.push("", "Supplemental task context:", params.task.trim());
	const prompt = taskLines.join("\n");
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPromptTemp.filePath];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	args.push(prompt);

	const invocation = getPiInvocation(args);
	let stderr = "";
	const messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];
	const liveActivity = params.createLiveRoleActivity(params.role);
	params.onUpdate?.(liveActivity);
	const heartbeat = setInterval(() => params.onUpdate?.(liveActivity), params.heartbeatMs);

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: params.root,
				env: { ...process.env, PI_COMPLETION_ROLE: params.role },
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as JsonRecord;
					if (params.applyLiveRoleEvent(liveActivity, event, messages)) params.onUpdate?.(liveActivity);
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

			if (params.signal) {
				const abort = () => proc.kill("SIGTERM");
				if (params.signal.aborted) abort();
				else params.signal.addEventListener("abort", abort, { once: true });
			}
		});

		const output = liveActivity.lastAssistantText || stderr.trim() || `${params.role} finished with no text output.`;
		const reportFields = parseReportFields(output);
		const transcription = exitCode === 0 ? await transcribeRoleOutput(params.role, params.root, output, reportFields) : undefined;
		if (transcription?.appended.length) params.onConsoleMessage?.("info", `Completion transcription appended: ${transcription.appended.join(", ")}`);
		if (transcription?.errors.length) params.onConsoleMessage?.("warning", `Completion transcription warning: ${transcription.errors.join(" | ")}`);
		return {
			role: params.role,
			ok: exitCode === 0,
			exitCode,
			output,
			stderr: stderr.trim(),
			reportFields,
			transcription,
			activity: params.cloneLiveRoleActivity(liveActivity, { status: exitCode === 0 ? "ok" : "error" }),
		};
	} finally {
		clearInterval(heartbeat);
		await fsp.rm(systemPromptTemp.dir, { recursive: true, force: true });
	}
}
