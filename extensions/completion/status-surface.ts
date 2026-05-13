import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
	asNumber,
	asString,
	asStringArray,
	completionRootKey,
	isRecord,
	loadCompletionSnapshot,
} from "./state-store";
import type { CompletionStatusSurface, CompletionStateSnapshot, JsonRecord, LiveRoleActivity } from "./types";

export const LIVE_ROLE_WAITING_MS = 15_000;
export const LIVE_ROLE_STALLED_MS = 45_000;

type LiveActivitySignal = {
	state: "active" | "waiting" | "stalled";
	idleMs: number;
};

export type RoleMessage = {
	role: string;
	content: Array<{ type: string; text?: string }>;
};

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

export function nowMs(): number {
	return envNumber("PI_COMPLETION_TEST_NOW") ?? Date.now();
}

export function formatElapsed(ms: number | undefined): string {
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

export function cloneLiveRoleActivity(activity: LiveRoleActivity, overrides: Partial<LiveRoleActivity> = {}): LiveRoleActivity {
	return {
		...activity,
		...overrides,
		toolRecentActivity: [...(overrides.toolRecentActivity ?? activity.toolRecentActivity)],
		recentActivity: [...(overrides.recentActivity ?? activity.recentActivity)],
		stateDeltas: [...(overrides.stateDeltas ?? activity.stateDeltas)],
	};
}

export function createLiveRoleActivity(role: string, startedAt = nowMs()): LiveRoleActivity {
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

export function lastAssistantText(messages: RoleMessage[]): string {
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

export function applyLiveRoleEvent(activity: LiveRoleActivity, event: JsonRecord, messages: RoleMessage[]): boolean {
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

export function maybeInjectTestLiveRoleActivity(liveRoleActivityByRoot: Map<string, LiveRoleActivity>, rootKey: string): void {
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

export function maybeReplayTestLiveRoleEvents(liveRoleActivityByRoot: Map<string, LiveRoleActivity>, rootKey: string): void {
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

export function buildInlineRunningLines(details: {
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

export function formatInlineRunningText(theme: any, lines: string[], options?: { primaryAssistant?: boolean }): string {
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

export function buildCompletionStatusSurface(
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

export async function refreshCompletionStatus(args: {
	ctx: { cwd: string; hasUI: boolean; ui: any };
	liveRoleActivityByRoot: Map<string, LiveRoleActivity>;
	completionStatusKey: string;
	safeUiCall: (action: () => void) => void;
	getCtxCwd: (ctx: { cwd: string }) => string;
	getCtxHasUI: (ctx: { hasUI: boolean }) => boolean;
	getCtxUi: <T extends { ui: any }>(ctx: T) => any | undefined;
}): Promise<void> {
	const cwd = args.getCtxCwd(args.ctx);
	const snapshot = await loadCompletionSnapshot(cwd);
	const rootKey = completionRootKey(snapshot, cwd);
	maybeInjectTestLiveRoleActivity(args.liveRoleActivityByRoot, rootKey);
	maybeReplayTestLiveRoleEvents(args.liveRoleActivityByRoot, rootKey);
	const surface = buildCompletionStatusSurface(snapshot, args.liveRoleActivityByRoot.get(rootKey));
	await writeCompletionStatusProbe(surface);
	if (!args.getCtxHasUI(args.ctx)) return;
	const ui = args.getCtxUi(args.ctx);
	if (!ui) return;
	args.safeUiCall(() => {
		ui.setWidget(args.completionStatusKey, surface.widgetLines.length > 0 ? surface.widgetLines : undefined);
	});
}
