import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { loadCompletionDataForReminder } from "./state-store";
import { parseReportFields, transcribeRoleOutput, type TranscriptionResult } from "./transcription";
import type { AgentDefinition, CompletionRole, JsonRecord, LiveRoleActivity } from "./types";

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

const AGENT_HOME = path.join(os.homedir(), ".pi", "agent");
const EXTENSION_DIR = typeof __dirname === "string" ? __dirname : process.cwd();
const PACKAGE_ROOT_CANDIDATE = path.resolve(EXTENSION_DIR, "..", "..");
const PACKAGE_ROOT = fs.existsSync(path.join(PACKAGE_ROOT_CANDIDATE, "package.json")) ? PACKAGE_ROOT_CANDIDATE : undefined;
const PACKAGE_AGENTS_DIR = PACKAGE_ROOT ? path.join(PACKAGE_ROOT, "agents") : undefined;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
