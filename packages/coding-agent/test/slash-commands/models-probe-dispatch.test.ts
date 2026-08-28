import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

/**
 * `/model probe` must be consumed by the slash dispatcher — not fall through to
 * the LLM as a message. The dispatcher rejects args on commands without
 * `allowArgs` (`executeBuiltinSlashCommand` returns false, and the input
 * controller then sends the text to the model), so this guards that gate.
 */
function createRuntime() {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	const showModelsProbe = vi.fn();
	return {
		showModelSelector,
		setText,
		showModelsProbe,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
				showModelsProbe,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model probe slash dispatch", () => {
	it("consumes `/model probe <pattern>` instead of sending it to the model", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model probe agentrouter", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelsProbe).toHaveBeenCalledWith({ pattern: "agentrouter", apply: false });
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});

	it("consumes `/model probe --apply` with no pattern", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model probe --apply", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelsProbe).toHaveBeenCalledWith({ apply: true });
	});

	it("routes `/models probe` (alias) to the same handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/models probe", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelsProbe).toHaveBeenCalledWith({ apply: false });
	});

	it("keeps bare `/model` on the picker path", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith();
		expect(harness.showModelsProbe).not.toHaveBeenCalled();
	});
});
