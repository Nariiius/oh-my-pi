import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AgentSession } from "../session/agent-session";
import { SessionBusyError } from "../session/agent-session";
import { collectPendingToolCalls } from "../session/exit-diagnostics";
import type { SessionManager } from "../session/session-manager";
import {
	cfgPrewalkAuto,
	cfgPrewalkEnabled,
	cfgRetryEnabled,
	cfgRetryModelFallback,
	cfgRetryUsageAwareFallback,
} from "../session/settings";
import { cfgToolsApprovalMode } from "../tools/settings";
import { checkOutboxReadiness } from "./readiness";
import type { OutboxStore } from "./store";
import type { OutboxJob } from "./types";

export type ResumeCondition = {
	state: "working" | "quota" | "completed" | "attention";
	reason: string;
};

/** Bind a watch to the original user request, never to whichever turn is current later. */
export function outboxResumeCondition(session: AgentSession, job: OutboxJob): ResumeCondition {
	const branch = session.sessionManager.getBranch();
	const originalAnchor = branch.findIndex(
		entry => entry.id === job.resumeUserEntryId && entry.type === "message" && entry.message.role === "user",
	);
	if (originalAnchor < 0)
		return {
			state: "attention",
			reason: "Original request is no longer on this chat branch; review before resuming.",
		};
	const currentAnchor = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user");
	if (currentAnchor !== originalAnchor && reconcileOutboxResume(session.sessionManager, job) !== "absent")
		return {
			state: "completed",
			reason: "A newer user request superseded this resume watch; no extra message was sent.",
		};
	const anchor = currentAnchor >= 0 ? currentAnchor : originalAnchor;
	const assistantEntry = branch
		.slice(anchor + 1)
		.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	const retainedFailure = session.getLastAssistantMessage();
	const last =
		assistantEntry?.type === "message" && assistantEntry.message.role === "assistant"
			? assistantEntry.message
			: retainedFailure?.stopReason === "error"
				? retainedFailure
				: undefined;
	const quotaFailure =
		last?.stopReason === "error" && AIError.is(AIError.classifyMessage(last), AIError.Flag.UsageLimit);
	if (quotaFailure && session.isRetrying && session.agent.state.pendingToolCalls.size === 0) {
		return {
			state: "quota",
			reason: "Quota blocked this request; outbox is monitoring the native wait.",
		};
	}
	if (
		session.agent.state.isStreaming ||
		session.isCompacting ||
		session.agent.state.pendingToolCalls.size > 0 ||
		session.isBusyForSnapshot ||
		session.hasPendingAsyncWork()
	) {
		return {
			state: "working",
			reason: "Watching existing work; will retry this request if quota blocks it.",
		};
	}
	if (collectPendingToolCalls(branch).length > 0 || session.hasAbortedToolCallTail) {
		return {
			state: "attention",
			reason: "An unfinished tool action has an unknown outcome; review it before resuming.",
		};
	}
	if (last?.stopReason === "error" && AIError.is(AIError.classifyMessage(last), AIError.Flag.UsageLimit)) {
		return {
			state: "quota",
			reason: "Quota stopped this request; outbox will recheck availability and retry it without adding a prompt.",
		};
	}
	if (last?.stopReason === "aborted")
		return {
			state: "attention",
			reason: "The request was interrupted, not quota-limited. Resume manually or cancel this watch.",
		};
	if (last?.stopReason === "error")
		return {
			state: "attention",
			reason: `Request failed for a reason other than quota: ${last.errorMessage ?? "unknown error"}`,
		};
	if (last?.stopReason === "stop" || last?.stopReason === "length")
		return {
			state: "completed",
			reason: "The original request finished; no extra continuation was sent.",
		};
	return {
		state: "attention",
		reason: "No safely retryable quota failure is recorded for the original request.",
	};
}

/** Called even while the watched live session is busy; never interrupts an active provider/tool request. */
export function observeOutboxResume(session: AgentSession, store: OutboxStore, job: OutboxJob): boolean {
	const condition = outboxResumeCondition(session, job);
	if (
		condition.state === "quota" &&
		session.isRetrying &&
		session.agent.state.pendingToolCalls.size === 0 &&
		session.abortRetryWait()
	) {
		// Only the retry sleep transfers; an active provider/tool request is never interrupted.
		store.watch(job.id, {
			reason: "Outbox is taking over quota waiting for this request.",
		});
		return false;
	}
	if (condition.state === "working") {
		store.watch(job.id, { reason: condition.reason });
		return false;
	}
	return !session.isBusyForSnapshot;
}

export function reconcileOutboxResume(manager: SessionManager, job: OutboxJob): "completed" | "accepted" | "absent" {
	const entries = manager.getBranch();
	let acceptedAt = -1;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (
			entry.type !== "custom" ||
			entry.customType !== "outbox.delivery" ||
			!entry.data ||
			typeof entry.data !== "object"
		)
			continue;
		if (!("jobId" in entry.data) || entry.data.jobId !== job.id || !("stage" in entry.data)) continue;
		if (entry.data.stage === "completed") return "completed";
		if (entry.data.stage === "accepted") acceptedAt = i;
		if (entry.data.stage === "waiting") acceptedAt = -1;
	}
	if (acceptedAt < 0) return "absent";
	const after = entries.slice(acceptedAt + 1);
	if (after.some(entry => entry.type === "message" && entry.message.role === "user")) return "accepted";
	const tail = after.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	if (
		!tail ||
		tail.type !== "message" ||
		tail.message.role !== "assistant" ||
		collectPendingToolCalls(entries).length > 0
	)
		return "accepted";
	if (tail.message.stopReason === "stop" || tail.message.stopReason === "length") return "completed";
	if (
		tail.message.stopReason === "error" &&
		AIError.is(AIError.classifyMessage(tail.message), AIError.Flag.UsageLimit)
	)
		return "absent";
	return "accepted";
}

export async function deliverOutboxResume(session: AgentSession, store: OutboxStore, job: OutboxJob): Promise<void> {
	const token = job.ownerToken;
	if (!token) throw new Error("Resume watch has no owner");
	if (
		session.sessionId !== job.sessionId ||
		path.resolve(session.sessionManager.getSessionFile() ?? "") !== path.resolve(job.sessionFile)
	) {
		store.updateOwned(job.id, token, {
			state: "attention",
			reason: "Resume destination changed; refused to retry another chat.",
		});
		return;
	}
	if (store.get(job.id)?.cancelRequested) {
		store.updateOwned(job.id, token, { state: "cancelled" });
		return;
	}
	const receipt = reconcileOutboxResume(session.sessionManager, job);
	if (receipt === "completed") {
		store.updateOwned(job.id, token, { state: "completed" });
		return;
	}
	if (receipt === "accepted") {
		store.updateOwned(job.id, token, {
			state: "attention",
			reason: "A resume attempt was interrupted before its outcome was recorded; review the original chat.",
		});
		return;
	}
	let condition = outboxResumeCondition(session, job);
	if (condition.state !== "quota") {
		store.updateOwned(job.id, token, {
			state: condition.state === "working" ? "waiting" : condition.state,
			reason: condition.reason,
		});
		return;
	}
	const readiness = await checkOutboxReadiness(session, job);
	if (readiness.state !== "ready") {
		store.updateOwned(job.id, token, readiness);
		return;
	}
	if (
		session.sessionId !== job.sessionId ||
		path.resolve(session.sessionManager.getSessionFile() ?? "") !== path.resolve(job.sessionFile)
	) {
		store.updateOwned(job.id, token, {
			state: "attention",
			reason: "The chat changed during quota verification; no other chat was resumed.",
		});
		return;
	}
	if (store.get(job.id)?.cancelRequested) {
		store.updateOwned(job.id, token, { state: "cancelled" });
		return;
	}
	condition = outboxResumeCondition(session, job);
	if (condition.state !== "quota") {
		store.updateOwned(job.id, token, {
			state: condition.state === "working" ? "waiting" : condition.state,
			reason: condition.reason,
		});
		return;
	}
	let release: () => void;
	try {
		session.sessionManager.claimForOutbox();
		release = session.beginOutboxDelivery(job.id, { resume: true });
	} catch (error) {
		if (error instanceof AgentBusyError || error instanceof SessionBusyError) {
			store.updateOwned(job.id, token, {
				state: "waiting",
				reason: "Waiting for the original chat to settle before resuming.",
			});
			return;
		}
		throw error;
	}
	const originalModel = session.model;
	const originalThinking = session.configuredThinkingLevel();
	const previous = {
		retry: cfgRetryEnabled.get(session.settings),
		fallback: cfgRetryModelFallback.get(session.settings),
		usageFallback: cfgRetryUsageAwareFallback.get(session.settings),
		prewalkAuto: cfgPrewalkAuto.get(session.settings),
		prewalk: cfgPrewalkEnabled.get(session.settings),
		approval: cfgToolsApprovalMode.get(session.settings),
	};
	let timer: NodeJS.Timeout | undefined;
	let pollError: unknown;
	try {
		cfgRetryEnabled.override(session.settings, false);
		cfgRetryModelFallback.override(session.settings, false);
		cfgRetryUsageAwareFallback.override(session.settings, false);
		cfgPrewalkAuto.override(session.settings, "off");
		cfgPrewalkEnabled.override(session.settings, false);
		const ranks: Record<string, number> = {
			yolo: 0,
			write: 1,
			"always-ask-cached": 2,
			"always-ask": 3,
		};
		if (job.approvalMode && (ranks[job.approvalMode] ?? 3) > ranks[previous.approval]!) {
			const policy =
				job.approvalMode === "write" || job.approvalMode === "always-ask-cached" ? job.approvalMode : "always-ask";
			cfgToolsApprovalMode.override(session.settings, policy);
		}
		const model = session.modelRegistry.find(job.provider, job.model);
		if (!model) throw new Error(`Queued model ${job.provider}/${job.model} is unavailable`);
		await session.setModelTemporary(model, job.thinkingLevel, {
			ephemeral: true,
		});
		if (store.get(job.id)?.cancelRequested) {
			store.updateOwned(job.id, token, { state: "cancelled" });
			return;
		}
		await session.sessionManager.appendEntriesAtomically(() =>
			session.sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "accepted",
				kind: "resume",
			}),
		);
		store.updateOwned(job.id, token, {
			state: "running",
			reason: "Resuming the original request; no new user prompt was added.",
		});
		timer = setInterval(() => {
			try {
				if (store.get(job.id)?.cancelRequested)
					void session.abort({ goalReason: "internal" }).catch(error => {
						pollError = error;
					});
			} catch (error) {
				pollError = error;
				void session.abort({ goalReason: "internal" }).catch(() => {});
			}
		}, 250);
		const retried = await session.retry(job.id);
		while (session.hasPendingAsyncWork()) await session.settleAsyncWork();
		await session.waitForIdle();
		if (pollError) throw pollError;
		if (store.get(job.id)?.cancelRequested) {
			store.updateOwned(job.id, token, { state: "cancelled" });
			return;
		}
		if (!retried)
			throw new Error("The original request could not be admitted for retry; no replacement prompt was sent.");
		condition = outboxResumeCondition(session, job);
		if (condition.state === "completed") {
			await session.sessionManager.appendEntriesAtomically(() =>
				session.sessionManager.appendCustomEntry("outbox.delivery", {
					jobId: job.id,
					stage: "completed",
					kind: "resume",
				}),
			);
			store.updateOwned(job.id, token, {
				state: "completed",
				reason: condition.reason,
			});
		} else if (condition.state === "quota") {
			await session.sessionManager.appendEntriesAtomically(() =>
				session.sessionManager.appendCustomEntry("outbox.delivery", {
					jobId: job.id,
					stage: "waiting",
					kind: "resume",
				}),
			);
			const availability = await checkOutboxReadiness(session, job);
			store.updateOwned(
				job.id,
				token,
				availability.state === "ready"
					? {
							state: "waiting",
							reason: "Provider still reports a quota limit; outbox will refresh availability before retrying.",
							nextCheckAt: Date.now() + 60_000,
					  }
					: availability,
			);
		} else {
			store.updateOwned(job.id, token, {
				state: "attention",
				reason: condition.reason,
			});
		}
	} catch (error) {
		store.updateOwned(job.id, token, {
			state: "attention",
			reason: `Resume needs attention: ${String(error)}`,
		});
	} finally {
		clearInterval(timer);
		try {
			if (originalModel)
				await session.setModelTemporary(originalModel, originalThinking, {
					ephemeral: true,
				});
		} finally {
			try {
				cfgRetryEnabled.override(session.settings, previous.retry);
				cfgRetryModelFallback.override(session.settings, previous.fallback);
				cfgRetryUsageAwareFallback.override(session.settings, previous.usageFallback);
				cfgPrewalkAuto.override(session.settings, previous.prewalkAuto);
				cfgPrewalkEnabled.override(session.settings, previous.prewalk);
				cfgToolsApprovalMode.override(session.settings, previous.approval);
			} finally {
				release();
			}
		}
	}
}
