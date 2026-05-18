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

export type NaturalLanguageCookTriggerMode = "off" | "assist" | "router" | "auto";
export type CookTriggerClassifierDecision = "offer_workflow" | "normal_prompt" | "unclear";
export type CookTriggerWorkflowBias = "startup" | "resume" | "refocus" | "next_round" | "unknown";

export type CookTriggerClassification = {
	decision: CookTriggerClassifierDecision;
	confidence: number;
	workflowBias: CookTriggerWorkflowBias;
	reason: string;
	focusHint?: string;
	evidence: string[];
	riskFlags: string[];
};

export type CookTriggerConfirmationAction = "start_workflow" | "send_as_normal_chat" | "cancel";
export type CookTriggerClarificationAction =
	| "route_startup"
	| "route_resume"
	| "route_refocus"
	| "route_next_round"
	| "send_as_normal_chat"
	| "cancel";
export type CookTriggerRecoveryAction = "retry_routing" | "send_as_normal_chat" | "cancel";
export type CookTriggerAdoptedArtifactKind = "recent_plan" | "repo_markdown";

export type CookTriggerConfirmationActionItem = {
	id: CookTriggerConfirmationAction;
	label: string;
	description: string;
};

export type CookTriggerClarificationActionItem = {
	id: CookTriggerClarificationAction;
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

export type CookTriggerClarificationCapsule = {
	goal?: string;
	scope?: string[];
	nonGoal?: string[];
	doneWhen?: string[];
	selectedWorkflowBias: CookTriggerWorkflowBias;
	reason: string;
};

export type CookTriggerAdoptedArtifact = {
	kind: CookTriggerAdoptedArtifactKind;
	basis: "explicit_user_adoption";
	title: string;
	path?: string;
	preview?: string;
};

export type CookNaturalLanguageHandoff = {
	preferredRoutingBias?: CookTriggerWorkflowBias;
	triggerText?: string;
	hintText?: string;
	clarificationCapsule?: CookTriggerClarificationCapsule;
	adoptedArtifact?: CookTriggerAdoptedArtifact;
};

export type CookTriggerClarificationLayout = {
	title: string;
	intro: string;
	currentMissionHeading?: string;
	currentMissionBody?: string;
	candidateMissionHeading?: string;
	candidateMissionBody?: string;
	adoptedArtifactHeading?: string;
	adoptedArtifactBody?: string;
	actionsHeading: string;
	actions: CookTriggerClarificationActionItem[];
	footer: string;
};

export type CookTriggerRecoveryActionItem = {
	id: CookTriggerRecoveryAction;
	label: string;
	description: string;
};

export type CookTriggerRecoveryLayout = {
	title: string;
	intro: string;
	failureHeading?: string;
	failureBody?: string;
	actionsHeading: string;
	actions: CookTriggerRecoveryActionItem[];
	footer: string;
};

export type CookTriggerDecision = {
	mode: NaturalLanguageCookTriggerMode;
	action: "continue" | "handled" | "routed_to_cook";
	reason: string;
	classification?: CookTriggerClassification;
	bypassReason?: string;
};
