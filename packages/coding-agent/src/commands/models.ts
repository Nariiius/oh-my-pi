/**
 * List, search, and refresh available models.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

export default class Models extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "ls (default) | find | refresh | probe | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "Filter/search substring, or provider name (required for find; optional filter for probe)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		apply: Flags.boolean({
			description: "Write models that responded to enabledModels in config (probe only)",
		}),
		timeout: Flags.integer({
			description: "Per-model probe timeout in seconds (probe only, default 20)",
			default: 20,
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before listing (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static examples = [
		`# List every available model, grouped by provider\n  ${APP_NAME} models`,
		`# List one provider's models (any provider name works)\n  ${APP_NAME} models openai-codex`,
		`# Find models by substring\n  ${APP_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.omp/models.db)\n  ${APP_NAME} models refresh`,
		`# Probe every available model with a minimal request, report what responds\n  ${APP_NAME} models probe`,
		`# Probe only one provider's models\n  ${APP_NAME} models probe agentrouter`,
		`# Probe and write the working models to enabledModels in config\n  ${APP_NAME} models probe --apply`,
		`# Machine-readable output\n  ${APP_NAME} models --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				apply: flags.apply,
				timeout: flags.timeout,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
