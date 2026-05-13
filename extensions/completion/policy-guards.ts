import * as path from "node:path";
import type { JsonRecord } from "./types";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPathInside(root: string, candidatePath: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidatePath);
	return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveToolPath(cwd: string, rawPath: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

export function isAllowedControlPlanePath(root: string, rawPath: string): boolean {
	const resolved = resolveToolPath(root, rawPath);
	if (path.basename(resolved) === ".gitignore") return true;
	return isPathInside(path.join(root, ".agent"), resolved);
}

function startsWithAny(value: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => value.startsWith(prefix));
}

export function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

export function isMutatingBash(command: string): boolean {
	const normalized = normalizeCommand(command);
	return (
		startsWithAny(normalized, [
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
		]) ||
		normalized.includes(">") ||
		normalized.includes("| tee") ||
		normalized.includes("apply_patch")
	);
}

export function toolCallBlockReason(args: {
	toolName: string;
	input?: JsonRecord;
	role?: string;
	completionActive: boolean;
	root: string;
}): string | undefined {
	const { toolName, input, role, completionActive, root } = args;

	if (toolName === "completion_role" && role) {
		return `Nested completion role dispatch is forbidden for ${role}.`;
	}

	if (toolName === "edit" || toolName === "write") {
		const rawPath = asString(input?.path);
		if (!rawPath) return undefined;

		if (role === "completion-reviewer" || role === "completion-auditor" || role === "completion-stop-judge") {
			return `${role} is read-only.`;
		}

		if ((role === "completion-bootstrapper" || role === "completion-regrounder") && !isAllowedControlPlanePath(root, rawPath)) {
			return `${role} may only edit .agent/** or .gitignore.`;
		}

		if (!role && completionActive && !isAllowedControlPlanePath(root, rawPath)) {
			return "The workflow driver may not edit tracked product files directly during completion.";
		}

		return undefined;
	}

	if (toolName !== "bash") return undefined;
	const command = asString(input?.command);
	if (!command) return undefined;
	const normalized = normalizeCommand(command);

	if (["completion-reviewer", "completion-auditor", "completion-stop-judge"].includes(role ?? "") && isMutatingBash(normalized)) {
		return `${role} is read-only and cannot run mutating bash.`;
	}

	if ((role === "completion-bootstrapper" || role === "completion-regrounder") && startsWithAny(normalized, ["git add", "git commit"])) {
		return `${role} may not create commits.`;
	}

	if (!role && completionActive && startsWithAny(normalized, ["git add", "git commit"])) {
		return "The workflow driver may not create commits directly during completion.";
	}

	return undefined;
}
