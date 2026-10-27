import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export type OutboxState =
	| "queued"
	| "waiting"
	| "watching"
	| "dispatching"
	| "running"
	| "completed"
	| "attention"
	| "cancelled";

export interface OutboxAttachment {
	path: string;
	mimeType: string;
}

export interface OutboxDraft {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
}

export interface OutboxNewJob extends OutboxDraft {
	kind?: "message" | "resume";
	resumeUserEntryId?: string;
	sessionId: string;
	sessionFile: string;
	branchId: string | null;
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	approvalMode?: string;
	sessionName?: string;
}

export interface OutboxJob {
	kind: "message" | "resume";
	resumeUserEntryId?: string;
	id: string;
	position: number;
	createdAt: number;
	updatedAt: number;
	sessionId: string;
	sessionFile: string;
	branchId: string | null;
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	approvalMode?: string;
	sessionName?: string;
	text: string;
	attachments: OutboxAttachment[];
	imageLinks?: (string | undefined)[];
	state: OutboxState;
	reason?: string;
	nextCheckAt?: number;
	ownerPid?: number;
	ownerToken?: string;
	cancelRequested: boolean;
}

export type OutboxReadiness =
	| { state: "ready" }
	| { state: "waiting"; reason: string; nextCheckAt: number }
	| { state: "attention"; reason: string };

export interface OutboxJobEdit {
	text?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface OutboxJobPatch {
	state?: OutboxState;
	reason?: string;
	nextCheckAt?: number;
}

export interface SessionOwnerInfo {
	pid: number;
	sessionFile: string;
}

export interface OutboxSessionSnapshot {
	sessionId: string;
	sessionFile: string;
	branchId: string | null;
	lastUserEntryId?: string | null;
	cwd: string;
	provider: string;
	model: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	approvalMode?: string;
	sessionName: string;
	activity: string;
	updatedAt: number;
	pid: number;
}

export type OutboxResumeDestination = Pick<
	OutboxSessionSnapshot,
	| "sessionId"
	| "sessionFile"
	| "cwd"
	| "provider"
	| "model"
	| "thinkingLevel"
	| "approvalMode"
	| "sessionName"
	| "lastUserEntryId"
>;
