import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildSkillPromptMessage, getSkillSlashCommandName, parseSkillInvocation } from "../extensibility/skills";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../slash-commands/builtin-registry";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../session/messages";
import type { InteractiveModeContext } from "./types";

type SkillCommandHost = Pick<
	InteractiveModeContext,
	| "skillCommands"
	| "showError"
	| "renderOptimisticSkillMessage"
	| "clearOptimisticSkillMessage"
	| "optimisticSkillMessagePending"
> & {
	session: Pick<InteractiveModeContext["session"], "promptCustomMessage" | "isStreaming">;
};

type SkillPromptMessage = Pick<
	CustomMessage<SkillPromptDetails>,
	"customType" | "content" | "display" | "details" | "attribution"
> & {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	content: string | (TextContent | ImageContent)[];
	display: true;
	details: SkillPromptDetails;
	attribution: "user";
};

type SkillPromptOptions = {
	streamingBehavior: "steer" | "followUp";
	queueChipText: string;
};

interface InvokeSkillCommandOptions {
	propagateErrors?: boolean;
	queueOnly?: boolean;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	/**
	 * Paint the built row before the awaited dispatch so a slow preflight (memory
	 * recall, `before_agent_start` hooks, auto-thinking, pre-prompt compaction)
	 * does not leave the submission invisible (issue #8895).
	 */
	optimistic?: boolean;
}

/** Built custom-message payload and delivery options for a `/skill:` command. */
export interface BuiltSkillCommandPrompt {
	message: SkillPromptMessage;
	options: SkillPromptOptions;
}

export function resolveSkillInvocation(
	ctx: SkillCommandHost,
	text: string,
): { name: string; args: string } | undefined {
	const parsed = parseSkillInvocation(text);
	if (parsed) return parsed;
	const trimmedStart = text.trimStart();
	if (!trimmedStart.startsWith("/") || trimmedStart.startsWith("/skill:")) return undefined;
	const spaceIndex = trimmedStart.indexOf(" ");
	const rawName = spaceIndex === -1 ? trimmedStart.slice(1) : trimmedStart.slice(1, spaceIndex);
	if (!rawName || BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(rawName)) return undefined;
	if (ctx.skillCommands.has(getSkillSlashCommandName({ name: rawName })) || ctx.skillCommands.has(rawName)) {
		const args = spaceIndex === -1 ? "" : trimmedStart.slice(spaceIndex + 1).trim();
		return { name: rawName, args };
	}
	return undefined;
}

/** Return true when `text` invokes a registered `/skill:<name>` or direct `/<name>` command. */
export function isKnownSkillCommand(ctx: SkillCommandHost, text: string): boolean {
	const parsed = resolveSkillInvocation(ctx, text);
	if (!parsed) return false;
	return ctx.skillCommands.has(getSkillSlashCommandName({ name: parsed.name })) || ctx.skillCommands.has(parsed.name);
}

/** Build the user-attributed custom message for a registered skill command. */
export async function buildSkillCommandPrompt(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	images?: ImageContent[],
): Promise<BuiltSkillCommandPrompt | undefined> {
	const parsed = resolveSkillInvocation(ctx, text);
	if (!parsed) return undefined;
	const skill =
		ctx.skillCommands.get(getSkillSlashCommandName({ name: parsed.name })) ?? ctx.skillCommands.get(parsed.name);
	if (!skill) return undefined;

	const built = await buildSkillPromptMessage(skill, parsed, "user");
	const textBlock: TextContent = { type: "text", text: built.message };
	const promptContent = images && images.length > 0 ? [textBlock, ...images] : built.message;

	return {
		message: {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: promptContent,
			display: true,
			details: built.details,
			attribution: "user",
		},
		options: { streamingBehavior, queueChipText: text },
	};
}

/** Invoke a registered `/skill:<name>` command as a user-attributed custom message. */
export async function invokeSkillCommandFromText(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	options?: InvokeSkillCommandOptions,
): Promise<boolean> {
	let optimistic = false;
	try {
		const built = await buildSkillCommandPrompt(ctx, text, streamingBehavior, options?.images);
		if (!built) return false;
		const promptOptions = options?.queueOnly ? { ...built.options, queueOnly: true } : built.options;
		optimistic = options?.optimistic === true && !options?.queueOnly && !ctx.session.isStreaming;
		if (optimistic) {
			ctx.renderOptimisticSkillMessage(
				{ role: "custom", ...built.message, timestamp: Date.now() },
				{ imageLinks: options?.imageLinks },
			);
		}
		await ctx.session.promptCustomMessage(built.message, promptOptions);
		return true;
	} catch (err) {
		if (optimistic) ctx.clearOptimisticSkillMessage();
		if (options?.propagateErrors) {
			throw err;
		}
		ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		return true;
	} finally {
		if (optimistic && ctx.optimisticSkillMessagePending) {
			// Dispatch resolved without a canonical skill message_start (aborted
			// preflight, or a streaming-race requeue): drop the pending row.
			ctx.clearOptimisticSkillMessage();
		}
	}
}
