import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { isOutboxSessionLive } from "./activity";
import { enqueueOutbox, snapshotOutboxSession } from "./service";
import type { OutboxStore } from "./store";
import type { OutboxDraft, OutboxJob, OutboxSessionSnapshot } from "./types";

export interface OutboxDestination extends Pick<
	OutboxSessionSnapshot,
	| "sessionId"
	| "sessionFile"
	| "branchId"
	| "cwd"
	| "provider"
	| "model"
	| "thinkingLevel"
	| "approvalMode"
	| "sessionName"
	| "activity"
	| "lastUserEntryId"
> {
	current: boolean;
	live: boolean;
}

/** Freeze identity/model before opening the editor; navigation must never retarget a saved draft. */
export function outboxDestinations(session: AgentSession, store: OutboxStore): OutboxDestination[] {
	const current = snapshotOutboxSession(session);
	const destinations = new Map<string, OutboxDestination>();
	for (const job of store.list()) {
		destinations.set(job.sessionId, {
			sessionId: job.sessionId,
			sessionFile: job.sessionFile,
			branchId: job.branchId,
			cwd: job.cwd,
			provider: job.provider,
			model: job.model,
			thinkingLevel: job.thinkingLevel,
			approvalMode: job.approvalMode,
			sessionName: job.sessionName ?? `${path.basename(job.cwd)} · ${job.sessionId.slice(-8)}`,
			activity: "No live status — last queued destination",
			current: false,
			live: false,
		});
	}
	for (const snapshot of store.sessions()) {
		const live = isOutboxSessionLive(snapshot);
		destinations.set(snapshot.sessionId, {
			...snapshot,
			current: false,
			live,
			activity: live ? snapshot.activity : "Live status unavailable — last reported destination",
		});
	}
	destinations.set(current.sessionId, {
		...current,
		current: true,
		live: true,
	});
	return [...destinations.values()].sort(
		(a, b) => Number(b.current) - Number(a.current) || a.sessionName.localeCompare(b.sessionName),
	);
}

export function outboxDestinationLabel(destination: OutboxDestination, index: number): string {
	const title = sanitizeText(destination.sessionName).replace(/\s+/g, " ").trim();
	return `${index + 1}. ${title}${destination.current ? " (current chat)" : ""}`;
}

export async function enqueueOutboxDestination(
	session: AgentSession,
	store: OutboxStore,
	destination: OutboxDestination,
	draft: OutboxDraft,
): Promise<OutboxJob> {
	if (destination.current) {
		const current = snapshotOutboxSession(session);
		if (
			current.sessionId !== destination.sessionId ||
			current.sessionFile !== destination.sessionFile ||
			current.provider !== destination.provider ||
			current.model !== destination.model ||
			current.thinkingLevel !== destination.thinkingLevel
		)
			throw new Error(
				"The destination chat or model changed. Cancel and select the destination again; your message has not been queued.",
			);
		if (
			destination.branchId !== null &&
			!session.sessionManager.getBranch().some(entry => entry.id === destination.branchId)
		) {
			throw new Error(
				"The destination chat switched branches. Cancel and select it again; your message has not been queued.",
			);
		}
		return enqueueOutbox(session, draft);
	}
	const known = outboxDestinations(session, store).some(
		candidate => candidate.sessionId === destination.sessionId && candidate.sessionFile === destination.sessionFile,
	);
	if (!known)
		throw new Error(
			"The selected chat is no longer registered. Select its destination again; your message has not been queued.",
		);
	return store.add({
		...draft,
		sessionId: destination.sessionId,
		sessionFile: destination.sessionFile,
		branchId: destination.branchId,
		cwd: destination.cwd,
		provider: destination.provider,
		model: destination.model,
		thinkingLevel: destination.thinkingLevel,
		approvalMode: destination.approvalMode,
		sessionName: destination.sessionName,
	});
}
