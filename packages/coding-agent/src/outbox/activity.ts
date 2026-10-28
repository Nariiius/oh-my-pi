import * as AIError from "@oh-my-pi/pi-ai/error";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { sessionDisplayName } from "../session/session-listing";
import { cfgToolsApprovalMode } from "../tools/settings";
import { outboxProcessAlive } from "./coordinator";
import type { OutboxStore } from "./store";
import type { OutboxSessionSnapshot } from "./types";

export function isOutboxSessionLive(snapshot: OutboxSessionSnapshot, now = Date.now()): boolean {
	const age = now - snapshot.updatedAt;
	return age >= -5_000 && age <= 15_000 && outboxProcessAlive(snapshot.pid);
}

export function sanitizeActivityText(text: string, width = 120): string {
	return truncateToWidth(sanitizeText(text).replace(/\s+/g, " ").trim(), width);
}

function settledActivity(session: AgentSession): string {
	const last = session.getLastAssistantMessage();
	if (last?.stopReason === "aborted") return "Interrupted";
	if (last?.stopReason === "error") {
		return AIError.is(AIError.classifyMessage(last), AIError.Flag.UsageLimit)
			? "Quota limited"
			: "Failed — needs attention";
	}
	return "Idle";
}

function firstUserText(session: AgentSession): string {
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		return typeof content === "string"
			? content
			: content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join(" ");
	}
	return "";
}

export function snapshotOutboxSession(session: AgentSession, activity?: string): OutboxSessionSnapshot {
	const manager = session.sessionManager;
	const model = session.model;
	const title = manager.getSessionName();
	return {
		lastUserEntryId:
			manager.getBranchView().findLast(entry => entry.type === "message" && entry.message.role === "user")?.id ??
			null,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile() ?? "",
		branchId: manager.getLeafId(),
		cwd: manager.getCwd(),
		provider: model?.provider ?? "",
		model: model?.id ?? "",
		thinkingLevel: session.configuredThinkingLevel(),
		approvalMode: cfgToolsApprovalMode.get(session.settings),
		sessionName: sanitizeActivityText(
			sessionDisplayName({
				title,
				firstMessage: title ? undefined : firstUserText(session),
				created: new Date(manager.getHeader()?.timestamp ?? Date.now()),
				modified: new Date(),
			}),
		),
		activity: sanitizeActivityText(
			activity ??
				(session.isRetrying
					? "Waiting to retry"
					: session.isCompacting
						? "Compacting"
						: session.isStreaming
							? "Working"
							: settledActivity(session)),
		),
		updatedAt: Date.now(),
		pid: process.pid,
	};
}

/** Observe without taking prompt ownership; publication continues while an outbox delivery is awaiting tools. */
export function startOutboxPresence(session: AgentSession, store: OutboxStore): () => void {
	const tools = new Map<string, string>();
	for (const update of session.activeToolExecutionUpdates()) {
		if (session.agent.state.pendingToolCalls.has(update.toolCallId)) tools.set(update.toolCallId, update.toolName);
	}
	let phase = session.isStreaming ? "Working" : "Idle";
	let retryAt: number | undefined;
	let compacting = session.isCompacting;
	let lastWrite = 0;
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	let publishing = false;
	let durableFile: string | undefined;
	let currentId = session.sessionManager.getSessionId();
	let lastError: string | undefined;

	const activity = (): string => {
		if (retryAt !== undefined) return `Retrying in ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))}s`;
		if (session.isRetrying) return "Waiting to retry";
		if (compacting || session.isCompacting) return "Compacting";
		if (tools.size) return [...tools.values()].join(" · ");
		if (phase === "Idle" && session.isBusyForSnapshot) return "Working";
		return phase === "Idle" ? settledActivity(session) : phase;
	};
	const reportError = (error: unknown): void => {
		const message = String(error);
		if (message === lastError) return;
		lastError = message;
		logger.warn("Outbox activity unavailable", {
			sessionId: currentId,
			error: message,
		});
		if (!stopped && !session.isDisposed)
			session.emitNotice("error", `Outbox activity unavailable: ${message}`, "outbox");
	};
	const publish = async (): Promise<void> => {
		if (stopped || publishing || session.isDisposed) return;
		publishing = true;
		lastWrite = Date.now();
		try {
			const manager = session.sessionManager;
			const id = manager.getSessionId();
			const file = manager.getSessionFile();
			if (!file || !session.model) return;
			if (durableFile !== file) {
				// Other chats may queue here, so the destination must survive closing an empty composer.
				await manager.ensureOnDisk();
				if (stopped || session.isDisposed || manager.getSessionId() !== id || manager.getSessionFile() !== file)
					return;
				durableFile = file;
			}
			store.publishSession(snapshotOutboxSession(session, activity()));
			lastError = undefined;
		} catch (error) {
			reportError(error);
		} finally {
			publishing = false;
		}
	};
	const schedule = (): void => {
		if (stopped || session.isDisposed || timer) return;
		const delay = Math.max(0, 1_000 - (Date.now() - lastWrite));
		timer = setTimeout(() => {
			timer = undefined;
			void publish();
		}, delay);
		timer.unref();
	};
	const setPhase = (value: string): void => {
		if (phase !== value) {
			phase = value;
			schedule();
		}
	};
	const unsubscribeEvents = session.subscribe(event => {
		if (stopped) return;
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				setPhase("Working");
				break;
			case "message_update": {
				const type = event.assistantMessageEvent.type;
				if (type === "thinking_start" || type === "thinking_delta") setPhase("Thinking");
				else if (type === "text_start" || type === "text_delta") setPhase("Responding");
				break;
			}
			case "tool_execution_start":
				tools.set(
					event.toolCallId,
					event.toolName === "ask"
						? "Waiting for input (ask)"
						: `${event.toolName}${event.intent ? `: ${sanitizeActivityText(event.intent)}` : ""}`,
				);
				schedule();
				break;
			case "tool_execution_end":
				tools.delete(event.toolCallId);
				phase = "Working";
				schedule();
				break;
			case "auto_retry_start":
				retryAt = Date.now() + event.delayMs;
				schedule();
				break;
			case "auto_retry_end":
				retryAt = undefined;
				phase = "Working";
				schedule();
				break;
			case "auto_compaction_start":
				compacting = true;
				schedule();
				break;
			case "auto_compaction_end":
				compacting = false;
				phase = "Working";
				schedule();
				break;
			case "agent_end":
				setPhase(event.yielded === false ? "Working" : "Idle");
				break;
			case "model_changed":
				schedule();
				break;
		}
	});
	const unsubscribeRun = session.subscribeRunState(state => setPhase(state === "idle" ? "Idle" : "Working"));
	const unsubscribeTitle = session.sessionManager.onSessionNameChanged(schedule);
	const unsubscribeSwitch = session.registerSessionChangeCallback(() => {
		try {
			store.unregisterSession(currentId, process.pid);
		} catch (error) {
			reportError(error);
		}
		currentId = session.sessionManager.getSessionId();
		durableFile = undefined;
		tools.clear();
		retryAt = undefined;
		compacting = session.isCompacting;
		phase = session.isStreaming ? "Working" : "Idle";
		schedule();
	});
	const heartbeat = setInterval(schedule, 5_000);
	heartbeat.unref();
	void publish();
	return () => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		clearInterval(heartbeat);
		unsubscribeEvents();
		unsubscribeRun();
		unsubscribeTitle();
		unsubscribeSwitch();
		try {
			store.unregisterSession(currentId, process.pid);
		} catch (error) {
			reportError(error);
		}
	};
}
