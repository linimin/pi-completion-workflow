import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompletionStateSnapshot, JsonRecord } from "./types";

const PROTOCOL_ID = "completion";
const DEFAULT_TASK_TYPE = "completion-workflow";
const DEFAULT_EVALUATION_PROFILE = "completion-rubric-v1";
const TRACKED_CONTRACT_FILES = [
	".agent/README.md",
	".agent/mission.md",
	".agent/profile.json",
	".agent/verify_completion_stop.sh",
	".agent/verify_completion_control_plane.sh",
] as const;

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
const { spawnSync } = require('node:child_process');

const REQUIRED_TRACKED_CONTRACT_FILES = [
  '.agent/README.md',
  '.agent/mission.md',
  '.agent/profile.json',
  '.agent/verify_completion_stop.sh',
  '.agent/verify_completion_control_plane.sh',
];

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

function asString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function sameStringArrays(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!options.allowFailure && result.status !== 0) {
    const stderr = asString(result.stderr) ?? 'git command failed';
    fail(\`git \${args.join(' ')} failed: \${stderr}\`);
  }
  return result;
}

function gitHeadSha() {
  const result = runGit(['rev-parse', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? asString(result.stdout) : undefined;
}

function ensureTrackedContractFiles() {
  for (const file of REQUIRED_TRACKED_CONTRACT_FILES) {
    const result = runGit(['ls-files', '--error-unmatch', file], { allowFailure: true });
    if (result.status !== 0) {
      fail(\`Required tracked completion contract file is missing from git index: \${file}\`);
    }
  }
}

function ensureCommitExists(commitish, label) {
  const result = runGit(['rev-parse', '--verify', \`\${commitish}^{commit}\`], { allowFailure: true });
  if (result.status !== 0) {
    fail(\`\${label} must resolve to an existing commit: \${commitish}\`);
  }
}

function trackedDiffFiles(fromCommit, toCommit) {
  const result = runGit(['diff', '--name-only', '--diff-filter=ACMR', \`\${fromCommit}..\${toCommit}\`]);
  return result.stdout
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');
const evidence = readJson('.agent/verification-evidence.json');

ensureTrackedContractFiles();

for (const [file, record] of [
  ['.agent/profile.json', profile],
  ['.agent/state.json', state],
  ['.agent/plan.json', plan],
  ['.agent/active-slice.json', active],
]) {
  if (!asString(record.task_type)) fail(file + ' is missing task_type');
  if (!asString(record.evaluation_profile)) fail(file + ' is missing evaluation_profile');
}

const taskType = asString(profile.task_type);
const evaluationProfile = asString(profile.evaluation_profile);
if (asString(state.task_type) !== taskType) fail('.agent/state.json task_type must match .agent/profile.json task_type');
if (asString(plan.task_type) !== taskType) fail('.agent/plan.json task_type must match .agent/profile.json task_type');
if (asString(active.task_type) !== taskType) fail('.agent/active-slice.json task_type must match .agent/profile.json task_type');
if (asString(state.evaluation_profile) !== evaluationProfile) fail('.agent/state.json evaluation_profile must match .agent/profile.json evaluation_profile');
if (asString(plan.evaluation_profile) !== evaluationProfile) fail('.agent/plan.json evaluation_profile must match .agent/profile.json evaluation_profile');
if (asString(active.evaluation_profile) !== evaluationProfile) fail('.agent/active-slice.json evaluation_profile must match .agent/profile.json evaluation_profile');

if (asString(evidence.artifact_type) !== 'completion-verification-evidence') {
  fail('.agent/verification-evidence.json artifact_type must be completion-verification-evidence');
}

const exactStatuses = new Set(['selected', 'in_progress', 'committed', 'done']);
const activeStatus = asString(active.status);
const exactHandoff = exactStatuses.has(activeStatus || '');
const planSlices = Array.isArray(plan.candidate_slices) ? plan.candidate_slices : [];
const activeSliceId = asString(active.slice_id);
const planSlice = activeSliceId ? planSlices.find((slice) => asString(slice && slice.slice_id) === activeSliceId) : undefined;

if (exactHandoff && !planSlice) {
  fail('slice_id must match a slice in .agent/plan.json when status carries an exact handoff');
}

if (exactHandoff) {
  const requiredStringFields = ['goal', 'why_now', 'basis_commit'];
  for (const field of requiredStringFields) {
    if (!asString(active[field])) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }
  const requiredArrayFields = ['contract_ids', 'acceptance_criteria', 'blocked_on', 'locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'remaining_contract_ids_before'];
  for (const field of requiredArrayFields) {
    if (!Array.isArray(active[field])) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }
  const requiredNumberFields = ['priority', 'release_blocker_count_before', 'high_value_gap_count_before'];
  for (const field of requiredNumberFields) {
    if (asNumber(active[field]) === undefined) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }

  const mismatchFields = [];
  if (asString(planSlice.slice_id) !== activeSliceId) mismatchFields.push('slice_id');
  if (asString(planSlice.goal) !== asString(active.goal)) mismatchFields.push('goal');
  if (!sameStringArrays(asStringArray(planSlice.contract_ids), asStringArray(active.contract_ids))) mismatchFields.push('contract_ids');
  if (!sameStringArrays(asStringArray(planSlice.acceptance_criteria), asStringArray(active.acceptance_criteria))) mismatchFields.push('acceptance_criteria');
  if (!sameStringArrays(asStringArray(planSlice.blocked_on), asStringArray(active.blocked_on))) mismatchFields.push('blocked_on');
  if (asNumber(planSlice.priority) !== asNumber(active.priority)) mismatchFields.push('priority');
  if (asString(planSlice.why_now) !== asString(active.why_now)) mismatchFields.push('why_now');
  const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
  for (const field of planMirrorFields) {
    const planValue = planSlice[field];
    const activeValue = active[field];
    if (Array.isArray(planValue) || Array.isArray(activeValue)) {
      if (!sameStringArrays(asStringArray(planValue), asStringArray(activeValue))) mismatchFields.push(field);
      continue;
    }
    if (typeof planValue === 'number' || typeof activeValue === 'number') {
      if (asNumber(planValue) !== asNumber(activeValue)) mismatchFields.push(field);
      continue;
    }
    if (asString(planValue) !== asString(activeValue)) mismatchFields.push(field);
  }
  if (mismatchFields.length > 0) {
    fail('.agent/active-slice.json must match the selected .agent/plan.json slice across: ' + mismatchFields.join(', '));
  }

  if (asString(evidence.subject_type) !== 'selected_slice') {
    fail('subject_type must be selected_slice when active slice exact handoff requires verification evidence');
  }
  if (asString(evidence.slice_id) !== activeSliceId) fail('.agent/verification-evidence.json slice_id must match .agent/active-slice.json slice_id');
  if (asString(evidence.goal) !== asString(active.goal)) fail('.agent/verification-evidence.json goal must match .agent/active-slice.json goal');
  if (!sameStringArrays(asStringArray(evidence.contract_ids), asStringArray(active.contract_ids))) fail('.agent/verification-evidence.json contract_ids must match .agent/active-slice.json contract_ids');
  if (asString(evidence.basis_commit) !== asString(active.basis_commit)) fail('.agent/verification-evidence.json basis_commit must match .agent/active-slice.json basis_commit');
  if (!sameStringArrays(asStringArray(evidence.verification_commands), asStringArray(active.verification_commands))) {
    fail('.agent/verification-evidence.json verification_commands must match .agent/active-slice.json verification_commands');
  }
  if (!asString(evidence.recorded_at)) fail('.agent/verification-evidence.json recorded_at must be present for selected-slice evidence');
  if (asString(evidence.outcome) === 'not_recorded') fail('.agent/verification-evidence.json outcome must not be not_recorded for selected-slice evidence');
  const headSha = gitHeadSha();
  if (headSha && asString(evidence.head_sha) !== headSha) {
    fail('.agent/verification-evidence.json head_sha must match current HEAD');
  }

  const basisCommit = asString(active.basis_commit);
  if (basisCommit && headSha) {
    ensureCommitExists(basisCommit, '.agent/active-slice.json basis_commit');
    const ancestorCheck = runGit(['merge-base', '--is-ancestor', basisCommit, headSha], { allowFailure: true });
    if (ancestorCheck.status !== 0) {
      fail(\`.agent/active-slice.json basis_commit must be an ancestor of current HEAD: \${basisCommit} -> \${headSha}\`);
    }
    const changedFiles = trackedDiffFiles(basisCommit, headSha);
    const implementationSurfaces = new Set(asStringArray(active.implementation_surfaces));
    const missingSurfaces = changedFiles.filter((file) => !implementationSurfaces.has(file));
    if (missingSurfaces.length > 0) {
      fail('.agent/active-slice.json implementation_surfaces must cover every tracked file changed from basis_commit to current HEAD; missing: ' + missingSurfaces.join(', '));
    }
  }
} else {
  const subjectType = asString(evidence.subject_type);
  if (subjectType === 'none') {
    if (asString(evidence.outcome) && asString(evidence.outcome) !== 'not_recorded') {
      fail('.agent/verification-evidence.json outcome must stay not_recorded when subject_type=none');
    }
  }
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

async function stageTrackedContractFiles(root: string): Promise<void> {
	if (!(await pathExists(path.join(root, ".git")))) return;
	const result = spawnSync("git", ["-C", root, "add", "--", ...TRACKED_CONTRACT_FILES], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const stderr = asString(result.stderr) ?? "git add failed while staging completion contract files";
		throw new Error(stderr);
	}
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
	await stageTrackedContractFiles(root);
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
