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

export type NaturalLanguageCookTriggerMode = "off" | "assist" | "auto";
export type CookTriggerIntent = "route_to_cook" | "normal_prompt" | "unclear";

export type CookTriggerClassification = {
	intent: CookTriggerIntent;
	confidence: number;
	reason: string;
	focusHint?: string;
	evidence: string[];
	riskFlags: string[];
};

export type CookTriggerConfirmationAction = "start_cook" | "keep_chatting" | "cancel";

export type CookTriggerConfirmationActionItem = {
	id: CookTriggerConfirmationAction;
	label: string;
	description: string;
};

export type CookTriggerConfirmationLayout = {
	title: string;
	intro: string;
	evidenceHeading?: string;
	evidenceBody?: string;
	riskHeading?: string;
	riskBody?: string;
	focusHintHeading?: string;
	focusHintBody?: string;
	actionsHeading: string;
	actions: CookTriggerConfirmationActionItem[];
	footer: string;
};

export type CookTriggerDecision = {
	mode: NaturalLanguageCookTriggerMode;
	action: "continue" | "handled" | "routed_to_cook";
	reason: string;
	classification?: CookTriggerClassification;
	bypassReason?: string;
};
