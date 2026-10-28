import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";
import { PromptDroppedError, SessionBusyError } from "../session/agent-session";
import { collectPendingToolCalls } from "../session/exit-diagnostics";
import type { SessionManager } from "../session/session-manager";
import {
	cfgPrewalkAuto,
	cfgPrewalkEnabled,
	cfgRetryModelFallback,
	cfgRetryUsageAwareFallback,
	cfgRetryWaitForUsageReset,
} from "../session/settings";
import { cfgToolsApprovalMode } from "../tools/settings";
import { checkOutboxReadiness } from "./readiness";
import { deliverOutboxResume, reconcileOutboxResume } from "./resume";
import type { OutboxStore } from "./store";
import type { OutboxJob } from "./types";

const APPROVAL_RANKS: Record<string, number> = {
	"always-ask": 3,
	"always-ask-cached": 2,
	write: 1,
	yolo: 0,
};

interface OutboxDeliveryReceipt {
	jobId: string;
	stage: "accepted" | "completed";
}

function parseDeliveryReceipt(data: unknown): OutboxDeliveryReceipt | undefined {
	if (data && typeof data === "object" && "jobId" in data && "stage" in data) {
		const candidateJobId = data.jobId;
		const candidateStage = data.stage;
		if (typeof candidateJobId === "string" && (candidateStage === "accepted" || candidateStage === "completed")) {
			return { jobId: candidateJobId, stage: candidateStage };
		}
	}
	return undefined;
}

/**
 * Reconcile an outbox job against persisted session custom entries.
 */
export function reconcileOutboxJob(
	sessionManager: SessionManager,
	job: OutboxJob,
): "completed" | "accepted" | "absent" {
	if (job.kind === "resume") return reconcileOutboxResume(sessionManager, job);
	const entries = sessionManager.getEntries();
	let accepted = false;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "outbox.delivery") {
			const receipt = parseDeliveryReceipt(entry.data);
			if (receipt && receipt.jobId === job.id) {
				if (receipt.stage === "completed") return "completed";
				if (receipt.stage === "accepted") accepted = true;
			}
		}
	}
	return accepted ? "accepted" : "absent";
}

/**
 * Delivers a claimed outbox job to an active AgentSession under strict admission,
 * transactional receipts, exact model/effort policy, and terminal lifecycle correlation.
 */
export async function deliverOutboxJob(session: AgentSession, store: OutboxStore, job: OutboxJob): Promise<void> {
	if (job.kind === "resume") return deliverOutboxResume(session, store, job);
	const ownerToken = job.ownerToken;
	if (!ownerToken) {
		throw new Error(`Cannot deliver outbox job ${job.id}: job has no owner token`);
	}

	const currentSessionId = session.sessionId;
	const currentSessionFile = session.sessionManager.getSessionFile();
	if (currentSessionId !== job.sessionId) {
		store.updateOwned(job.id, ownerToken, {
			state: "attention",
			reason: `Session identity mismatch: session is ${currentSessionId}, job targets ${job.sessionId}`,
		});
		return;
	}
	if (currentSessionFile && path.resolve(currentSessionFile) !== path.resolve(job.sessionFile)) {
		store.updateOwned(job.id, ownerToken, {
			state: "attention",
			reason: `Session file mismatch: active is ${currentSessionFile}, job targets ${job.sessionFile}`,
		});
		return;
	}

	if (store.get(job.id)?.cancelRequested) {
		store.updateOwned(job.id, ownerToken, {
			state: "cancelled",
			reason: "Cancelled by user before delivery setup",
		});
		return;
	}

	const existingStage = reconcileOutboxJob(session.sessionManager, job);
	if (existingStage === "completed") {
		store.updateOwned(job.id, ownerToken, { state: "completed" });
		return;
	}
	if (existingStage === "accepted") {
		store.updateOwned(job.id, ownerToken, {
			state: "attention",
			reason: "Job was already accepted in session transcript; refused duplicate delivery to prevent double-send",
		});
		return;
	}

	if (job.branchId !== null) {
		const branch = session.sessionManager.getBranch();
		const branchIds = new Set(branch.map(entry => entry.id));
		if (!branchIds.has(job.branchId)) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: `Branch mismatch: queued branch ${job.branchId} is not in active ancestry`,
			});
			return;
		}
	}

	if (store.get(job.id)?.cancelRequested) {
		store.updateOwned(job.id, ownerToken, {
			state: "cancelled",
			reason: "Cancelled by user before readiness check",
		});
		return;
	}

	const readiness = await checkOutboxReadiness(session, job);
	if (readiness.state === "waiting") {
		store.updateOwned(job.id, ownerToken, {
			state: "waiting",
			reason: readiness.reason,
			nextCheckAt: readiness.nextCheckAt,
		});
		return;
	}
	if (readiness.state === "attention") {
		store.updateOwned(job.id, ownerToken, {
			state: "attention",
			reason: readiness.reason,
		});
		return;
	}
	if (
		session.sessionId !== job.sessionId ||
		session.sessionManager.getSessionFile() !== currentSessionFile ||
		(job.branchId !== null && !session.sessionManager.getBranch().some(entry => entry.id === job.branchId))
	) {
		store.updateOwned(job.id, ownerToken, {
			state: "attention",
			reason: "Target chat or branch changed during quota verification.",
		});
		return;
	}

	if (store.get(job.id)?.cancelRequested) {
		store.updateOwned(job.id, ownerToken, {
			state: "cancelled",
			reason: "Cancelled by user before admission",
		});
		return;
	}

	let releaseDelivery: (() => void) | undefined;
	try {
		session.sessionManager.claimForOutbox();
		releaseDelivery = session.beginOutboxDelivery(job.id);
	} catch (err) {
		if (err instanceof AgentBusyError || err instanceof SessionBusyError) {
			store.updateOwned(job.id, ownerToken, {
				state: "waiting",
				reason: "Session is busy with active turn, manual submission, or maintenance",
			});
			return;
		}
		throw err;
	}

	const prevModel = session.model;
	const prevThinking = session.configuredThinkingLevel();
	const prevModelFallback = cfgRetryModelFallback.get(session.settings);
	const prevUsageAwareFallback = cfgRetryUsageAwareFallback.get(session.settings);
	const prevWaitForUsageReset = cfgRetryWaitForUsageReset.get(session.settings);
	const prevPrewalkAuto = cfgPrewalkAuto.get(session.settings);
	const prevPrewalkEnabled = cfgPrewalkEnabled.get(session.settings);
	const prevApprovalMode = cfgToolsApprovalMode.get(session.settings);

	let modelSwitched = false;

	try {
		cfgRetryModelFallback.override(session.settings, false);
		cfgRetryUsageAwareFallback.override(session.settings, false);
		cfgRetryWaitForUsageReset.override(session.settings, true);
		cfgPrewalkAuto.override(session.settings, "off");
		cfgPrewalkEnabled.override(session.settings, false);

		if (job.approvalMode && APPROVAL_RANKS[job.approvalMode] !== undefined) {
			const jobRank = APPROVAL_RANKS[job.approvalMode];
			const currentRank = APPROVAL_RANKS[prevApprovalMode] ?? 0;
			if (currentRank < jobRank) {
				cfgToolsApprovalMode.override(
					session.settings,
					job.approvalMode as "always-ask" | "always-ask-cached" | "write" | "yolo",
				);
			}
		}

		const images = await store.readImages(job);

		const targetModel = session.modelRegistry.find(job.provider, job.model);
		if (!targetModel) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: `Model ${job.provider}/${job.model} not found in registry`,
			});
			return;
		}

		await session.setModelTemporary(targetModel, job.thinkingLevel, {
			ephemeral: true,
		});
		modelSwitched = true;

		if (store.get(job.id)?.cancelRequested) {
			store.updateOwned(job.id, ownerToken, {
				state: "cancelled",
				reason: "Cancelled by user after model switch",
			});
			return;
		}

		store.updateOwned(job.id, ownerToken, { state: "running" });

		let promptSuccess = false;
		let executionError: unknown;
		let cancelPoller: ReturnType<typeof setInterval> | undefined;
		let cancelActive = true;
		let pollError: unknown;

		try {
			cancelPoller = setInterval(() => {
				if (!cancelActive) return;
				try {
					const polled = store.get(job.id);
					if (polled?.cancelRequested) {
						cancelActive = false;
						clearInterval(cancelPoller);
						cancelPoller = undefined;
						session.abort({ goalReason: "internal" }).catch(() => {});
					}
				} catch (err) {
					cancelActive = false;
					clearInterval(cancelPoller);
					cancelPoller = undefined;
					pollError = err;
					session.abort({ goalReason: "internal" }).catch(() => {});
				}
			}, 250);

			try {
				promptSuccess = await session.prompt(job.text, {
					images: images.length > 0 ? images : undefined,
					imageLinks: job.imageLinks,
					outboxJobId: job.id,
					runCommands: false,
					expandPromptTemplates: true,
					throwOnDrop: true,
				});
			} catch (err) {
				executionError = err;
			}

			await session.waitForIdle();
			while (session.hasPendingAsyncWork()) await session.settleAsyncWork();
		} finally {
			cancelActive = false;
			clearInterval(cancelPoller);
			cancelPoller = undefined;
		}

		if (pollError) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: `Outbox store query failed during delivery: ${pollError instanceof Error ? pollError.message : String(pollError)}`,
			});
			return;
		}

		if (session.sessionId !== job.sessionId) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: "Active session changed during outbox delivery",
			});
			return;
		}

		const postJob = store.get(job.id);
		if (postJob?.cancelRequested) {
			store.updateOwned(job.id, ownerToken, {
				state: "cancelled",
				reason: "Cancelled by user",
			});
			return;
		}

		if (executionError) {
			if (executionError instanceof PromptDroppedError) {
				store.updateOwned(job.id, ownerToken, {
					state: "waiting",
					reason: "Prompt was dropped before dispatch; eligible for retry",
				});
				return;
			}
			const errorMsg = executionError instanceof Error ? executionError.message : String(executionError);
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: `Execution failed: ${errorMsg}`,
			});
			return;
		}

		const branch = session.sessionManager.getBranch();
		const acceptedIndex = branch.findIndex(entry => {
			if (entry.type !== "custom" || entry.customType !== "outbox.delivery") return false;
			const receipt = parseDeliveryReceipt(entry.data);
			return receipt?.jobId === job.id && receipt.stage === "accepted";
		});

		let turnAssistant: AssistantMessage | undefined;
		if (acceptedIndex >= 0) {
			for (let i = acceptedIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					turnAssistant = entry.message as AssistantMessage;
				}
			}
		}

		if (!turnAssistant) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: "Turn settled without assistant response",
			});
			return;
		}

		if (turnAssistant.stopReason === "toolUse" || collectPendingToolCalls(branch).length > 0) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: "Turn paused awaiting user interaction, tool approval, or external action",
			});
			return;
		}

		if (turnAssistant.stopReason === "aborted") {
			if (postJob?.cancelRequested) {
				store.updateOwned(job.id, ownerToken, {
					state: "cancelled",
					reason: "Cancelled by user",
				});
			} else {
				store.updateOwned(job.id, ownerToken, {
					state: "attention",
					reason: "Execution aborted by manual operator interrupt (paused)",
				});
			}
			return;
		}

		if (turnAssistant.stopReason === "error") {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: turnAssistant.errorMessage || "Model execution ended with error",
			});
			return;
		}

		if (turnAssistant.stopReason !== "stop" && turnAssistant.stopReason !== "length") {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: `Turn ended with non-terminal status: ${turnAssistant.stopReason}`,
			});
			return;
		}

		if (!promptSuccess) {
			store.updateOwned(job.id, ownerToken, {
				state: "attention",
				reason: "Prompt was not successfully dispatched to agent",
			});
			return;
		}

		await session.sessionManager.appendEntriesAtomically(() => {
			session.sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "completed",
			});
		});

		store.updateOwned(job.id, ownerToken, { state: "completed" });
	} finally {
		try {
			if (modelSwitched && prevModel) {
				await session.setModelTemporary(prevModel, prevThinking, {
					ephemeral: true,
				});
			}
		} finally {
			cfgRetryModelFallback.override(session.settings, prevModelFallback);
			cfgRetryUsageAwareFallback.override(session.settings, prevUsageAwareFallback);
			cfgRetryWaitForUsageReset.override(session.settings, prevWaitForUsageReset);
			cfgPrewalkAuto.override(session.settings, prevPrewalkAuto);
			cfgPrewalkEnabled.override(session.settings, prevPrewalkEnabled);
			cfgToolsApprovalMode.override(session.settings, prevApprovalMode);
			releaseDelivery?.();
		}
	}
}
