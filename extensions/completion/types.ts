export const ROLE_NAMES = [
	"completion-bootstrapper",
	"completion-regrounder",
	"completion-implementer",
	"completion-reviewer",
	"completion-auditor",
	"completion-stop-judge",
] as const;

export type CompletionRole = (typeof ROLE_NAMES)[number];
export type JsonRecord = Record<string, unknown>;

export type CompletionFiles = {
	root: string;
	agentDir: string;
	tmpDir: string;
	profilePath: string;
	statePath: string;
	planPath: string;
	activePath: string;
	sliceHistoryPath: string;
	stopHistoryPath: string;
	verificationEvidencePath: string;
	compactionMarkerPath: string;
};

export type CompletionStateSnapshot = {
	files: CompletionFiles;
	profile?: JsonRecord;
	state?: JsonRecord;
	plan?: JsonRecord;
	active?: JsonRecord;
	verificationEvidence?: JsonRecord;
	activeSlice?: JsonRecord;
};

export type AgentDefinition = {
	name: string;
	description?: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
};

export type LiveRoleActivity = {
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

export type CompletionStatusSurface = {
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
