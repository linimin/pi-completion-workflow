import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompletionStateSnapshot, JsonRecord } from "./types";

const PROTOCOL_ID = "completion";
const DEFAULT_TASK_TYPE = "completion-workflow";
const DEFAULT_EVALUATION_PROFILE = "completion-rubric-v1";

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveFiles(root: string) {
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
		verificationEvidencePath: path.join(agentDir, "verification-evidence.json"),
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

function completionSearchRoots(startCwd: string): string[] {
	return [...new Set([path.resolve(startCwd), path.resolve(process.cwd())])];
}

export function findCompletionRoot(startCwd: string): string | undefined {
	for (const candidateRoot of completionSearchRoots(startCwd)) {
		const profilePath = walkUpForDir(candidateRoot, [".agent", "profile.json"]);
		if (profilePath) return path.dirname(path.dirname(profilePath));
	}
	return undefined;
}

export function findRepoRoot(startCwd: string): string | undefined {
	for (const candidateRoot of completionSearchRoots(startCwd)) {
		const gitPath = walkUpForDir(candidateRoot, [".git"]);
		if (gitPath) return path.dirname(gitPath);
	}
	return undefined;
}

export function completionRootKey(snapshot: CompletionStateSnapshot | undefined, cwd: string): string {
	return snapshot?.files.root ?? findCompletionRoot(cwd) ?? findRepoRoot(cwd) ?? path.resolve(cwd);
}

export async function readJson(filePath: string): Promise<JsonRecord | undefined> {
	try {
		const raw = await fsp.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function readJsonl(filePath: string): Promise<JsonRecord[]> {
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

export async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
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

export async function loadCompletionSnapshot(startCwd: string): Promise<CompletionStateSnapshot | undefined> {
	const root = findCompletionRoot(startCwd);
	if (!root) return undefined;
	const files = resolveFiles(root);
	const profile = await readJson(files.profilePath);
	if (asString(profile?.protocol_id) !== PROTOCOL_ID) return undefined;
	const state = await readJson(files.statePath);
	const plan = await readJson(files.planPath);
	const active = await readJson(files.activePath);
	const verificationEvidence = await readJson(files.verificationEvidencePath);
	return {
		files,
		profile,
		state,
		plan,
		active,
		verificationEvidence,
		activeSlice: findActiveSlice(plan, active),
	};
}

export async function loadCompletionDataForReminder(startCwd: string) {
	const snapshot = await loadCompletionSnapshot(startCwd);
	if (!snapshot) return undefined;
	const sliceHistory = await readJsonl(snapshot.files.sliceHistoryPath);
	const stopHistory = await readJsonl(snapshot.files.stopHistoryPath);
	return { snapshot, sliceHistory, stopHistory };
}

export async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fsp.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

export async function readText(filePath: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

export async function detectDocsSurfaces(root: string): Promise<string[]> {
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
	if ((await pathExists(path.join(root, "bun.lockb"))) || (await pathExists(path.join(root, "bun.lock")))) return "bun test";
	if (await pathExists(path.join(root, "yarn.lock"))) return "yarn test";
	if (await pathExists(path.join(root, "Cargo.toml"))) return "cargo test";
	if ((await pathExists(path.join(root, "pyproject.toml"))) || (await pathExists(path.join(root, "pytest.ini")))) return "pytest";
	if (await pathExists(path.join(root, "go.mod"))) return "go test ./...";
	if (await pathExists(path.join(root, "Makefile"))) return "make test";
	return undefined;
}

export function buildProfileRecord(args: {
	projectName: string;
	requiredStopJudges: number;
	priorityPolicyId?: string;
	docsSurfaces: string[];
	taskType?: string;
	evaluationProfile?: string;
}): JsonRecord {
	return {
		schema_version: 1,
		protocol_id: PROTOCOL_ID,
		project_name: args.projectName,
		required_stop_judges: args.requiredStopJudges,
		priority_policy_id: args.priorityPolicyId ?? "completion-default",
		task_type: args.taskType ?? DEFAULT_TASK_TYPE,
		evaluation_profile: args.evaluationProfile ?? DEFAULT_EVALUATION_PROFILE,
		docs_surfaces: args.docsSurfaces,
	};
}

export function defaultState(
	missionAnchor: string,
	routing?: { taskType?: string; evaluationProfile?: string; continuationReason?: string },
	advisoryStartupBrief?: JsonRecord,
): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		advisory_startup_brief: advisoryStartupBrief ?? null,
		current_phase: "reground",
		continuation_policy: "continue",
		continuation_reason: routing?.continuationReason ?? "Fresh completion bootstrap requires canonical re-ground",
		project_done: false,
		task_type: routing?.taskType ?? DEFAULT_TASK_TYPE,
		evaluation_profile: routing?.evaluationProfile ?? DEFAULT_EVALUATION_PROFILE,
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

export function defaultPlan(
	missionAnchor: string,
	routing?: { taskType?: string; evaluationProfile?: string },
): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		task_type: routing?.taskType ?? DEFAULT_TASK_TYPE,
		evaluation_profile: routing?.evaluationProfile ?? DEFAULT_EVALUATION_PROFILE,
		last_reground_at: null,
		plan_basis: "bootstrap",
		candidate_slices: [],
	};
}

export function defaultActiveSlice(
	missionAnchor: string,
	routing?: { taskType?: string; evaluationProfile?: string },
): JsonRecord {
	return {
		schema_version: 1,
		mission_anchor: missionAnchor,
		task_type: routing?.taskType ?? DEFAULT_TASK_TYPE,
		evaluation_profile: routing?.evaluationProfile ?? DEFAULT_EVALUATION_PROFILE,
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

export function defaultVerificationEvidence(): JsonRecord {
	return {
		schema_version: 1,
		artifact_type: "completion-verification-evidence",
		subject_type: "none",
		slice_id: null,
		goal: null,
		contract_ids: [],
		basis_commit: null,
		head_sha: null,
		verification_commands: [],
		outcome: "not_recorded",
		recorded_at: null,
		summary: "No deterministic verification evidence is recorded yet because no selected slice or current-HEAD verification subject exists.",
	};
}

export function buildAgentReadme(projectName: string): string {
	return `# Completion Control Plane\n\nThis repository uses the \`completion\` workflow for long-running coding tasks.\n\n## Canonical tracked contract files\n\n- \`.agent/README.md\`\n- \`.agent/mission.md\`\n- \`.agent/profile.json\`\n- \`.agent/verify_completion_stop.sh\`\n- \`.agent/verify_completion_control_plane.sh\`\n\n## Ignored canonical execution state\n\n- \`.agent/state.json\`\n- \`.agent/plan.json\`\n- \`.agent/active-slice.json\`\n- \`.agent/slice-history.jsonl\`\n- \`.agent/stop-check-history.jsonl\`\n- \`.agent/verification-evidence.json\`\n- \`.agent/*.log\`\n- \`.agent/tmp/\`\n\n\`.agent/verification-evidence.json\` is the durable canonical record of deterministic verification for the selected slice or current HEAD. Recovery, review, audit, and stop-check reminder surfaces consume it instead of temp-only artifacts or conversational summaries when it is populated.\n\nThe source of truth for long-running completion work is canonical \`.agent/**\` state plus current repo truth.\n\nProject: ${projectName}\n`;
}

export function buildMission(projectName: string, missionAnchor: string): string {
	return `# Mission\n\nProject: ${projectName}\n\nMission anchor:\n${missionAnchor}\n\nThis file is a tracked human-readable statement of the repo's completion mission. Re-grounders may refine this file when repo truth becomes clearer, but it must stay truthful to shipped behavior and the active completion objective.\n`;
}

export function buildVerifyStopScript(verifierCommand?: string): string {
	const repoCheck = verifierCommand
		? `echo "[completion] running repo-level verification: ${verifierCommand}"\n${verifierCommand}`
		: `echo "[completion] no repo-specific verifier auto-detected; control-plane verification only"`;
	return `#!/usr/bin/env bash\nset -euo pipefail\n\nbash .agent/verify_completion_control_plane.sh\n${repoCheck}\n`;
}

export function buildVerifyControlPlaneScript(): string {
	const trackedScriptPath = path.resolve(__dirname, "..", "..", ".agent", "verify_completion_control_plane.sh");
	if (fs.existsSync(trackedScriptPath)) {
		return fs.readFileSync(trackedScriptPath, "utf8");
	}
	return `#!/usr/bin/env bash
':' //; exec node "$0" "$@"
const fs = require('node:fs');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('Failed to read ' + file + ': ' + error.message);
  }
}

for (const file of ['.agent/profile.json', '.agent/state.json', '.agent/plan.json', '.agent/active-slice.json', '.agent/verification-evidence.json']) {
  readJson(file);
}
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

export type ScaffoldResult = {
	root: string;
	created: string[];
	updated: string[];
	missionAnchor: string;
};

export async function scaffoldCompletionFiles(
	root: string,
	missionAnchor: string,
	options?: { analysis?: { taskType?: string; evaluationProfile?: string }; continuationReason?: string; advisoryStartupBrief?: JsonRecord },
): Promise<ScaffoldResult> {
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
			content: `${JSON.stringify(buildProfileRecord({ projectName, requiredStopJudges: 3, docsSurfaces, taskType: options?.analysis?.taskType, evaluationProfile: options?.analysis?.evaluationProfile }), null, 2)}\n`,
		},
		{ path: path.join(files.agentDir, "verify_completion_stop.sh"), content: buildVerifyStopScript(verifierCommand), executable: true },
		{ path: path.join(files.agentDir, "verify_completion_control_plane.sh"), content: buildVerifyControlPlaneScript(), executable: true },
		{
			path: files.statePath,
			content: `${JSON.stringify(defaultState(missionAnchor, { taskType: options?.analysis?.taskType, evaluationProfile: options?.analysis?.evaluationProfile, continuationReason: options?.continuationReason }, options?.advisoryStartupBrief), null, 2)}\n`,
		},
		{ path: files.planPath, content: `${JSON.stringify(defaultPlan(missionAnchor, { taskType: options?.analysis?.taskType, evaluationProfile: options?.analysis?.evaluationProfile }), null, 2)}\n` },
		{ path: files.activePath, content: `${JSON.stringify(defaultActiveSlice(missionAnchor, { taskType: options?.analysis?.taskType, evaluationProfile: options?.analysis?.evaluationProfile }), null, 2)}\n` },
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

export function currentTaskType(snapshot: CompletionStateSnapshot): string | undefined {
	return (
		asString(snapshot.active?.task_type) ??
		asString(snapshot.state?.task_type) ??
		asString(snapshot.plan?.task_type) ??
		asString(snapshot.profile?.task_type)
	);
}

export function currentEvaluationProfile(snapshot: CompletionStateSnapshot): string | undefined {
	return (
		asString(snapshot.active?.evaluation_profile) ??
		asString(snapshot.state?.evaluation_profile) ??
		asString(snapshot.plan?.evaluation_profile) ??
		asString(snapshot.profile?.evaluation_profile)
	);
}

export function currentMissionAnchor(snapshot: CompletionStateSnapshot): string {
	return (
		asString(snapshot.state?.mission_anchor) ??
		asString(snapshot.plan?.mission_anchor) ??
		asString(snapshot.active?.mission_anchor) ??
		path.basename(snapshot.files.root)
	);
}

export { asNumber, asString, asStringArray, isRecord };
