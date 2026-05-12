import { spawn } from "node:child_process";
import * as roleReporting from "./role-reporting.js";
import { loadCompletionSnapshot } from "./state-store";
import type { CompletionRole, JsonRecord } from "./types";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export type TranscriptionResult = {
	appended: string[];
	skipped: string[];
	errors: string[];
};

export function parseReportFields(text: string): Record<string, string> {
	return roleReporting.parseReportFields(text);
}

export function parseYesNo(value: string | undefined): boolean | undefined {
	return roleReporting.parseYesNo(value);
}

export function parseFirstNumber(value: string | undefined): number | undefined {
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

export async function transcribeRoleOutput(
	role: CompletionRole,
	cwd: string,
	output: string,
	reportFields: Record<string, string>,
): Promise<TranscriptionResult> {
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

export async function appendJsonlRecord(filePath: string, record: JsonRecord): Promise<void> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
