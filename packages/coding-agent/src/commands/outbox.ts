import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { outboxHelp } from "../cli/command-help";
import { getOutboxStore, pauseOutbox, startOutbox } from "../outbox/service";

export default class Outbox extends Command {
	static description = outboxHelp.description;
	static args = {
		action: Args.string({
			description: "list, run, pause, cancel, remove, retry, move, or edit",
			options: ["list", "run", "pause", "cancel", "remove", "retry", "move", "edit"],
		}),
		id: Args.string({ description: "Exact queued message ID" }),
		position: Args.string({ description: "New one-based position for move" }),
	};
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit queue state as JSON" }),
		text: Flags.string({ description: "Replacement message text for edit" }),
	};
	static examples = [
		"omp outbox",
		"omp outbox run",
		"omp outbox pause",
		"omp outbox move <id> 1",
		"omp outbox remove <id>",
		"omp outbox --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Outbox);
		const store = getOutboxStore();
		const action = args.action ?? "list";
		if (["cancel", "remove", "retry", "move", "edit"].includes(action) && !args.id)
			throw new Error(`${action} requires a message ID.`);
		switch (action) {
			case "run":
				await startOutbox();
				break;
			case "pause":
				pauseOutbox();
				break;
			case "cancel":
				store.cancel(args.id!);
				break;
			case "remove":
				store.remove(args.id!);
				break;
			case "retry":
				store.retry(args.id!);
				break;
			case "move": {
				const position = Number(args.position);
				if (!Number.isSafeInteger(position) || position < 1)
					throw new Error("move requires a positive queue position.");
				store.move(args.id!, position);
				break;
			}
			case "edit":
				if (flags.text === undefined) throw new Error("edit requires --text.");
				store.edit(args.id!, { text: flags.text });
				break;
		}
		const snapshot = { armed: store.isArmed(), jobs: store.list() };
		if (flags.json) {
			console.log(JSON.stringify(snapshot, null, 2));
			return;
		}
		console.log(
			`Outbox ${snapshot.armed ? "armed" : "paused"}; ${snapshot.jobs.length} saved messages`,
		);
		for (const job of snapshot.jobs) {
			console.log(
				`${job.position}. [${job.state}] ${job.id} ${JSON.stringify(job.sessionName ?? job.sessionId)} ${JSON.stringify(`${job.provider}/${job.model}`)}`,
			);
			console.log(`   ${JSON.stringify(job.text.slice(0, 160))}`);
			if (job.reason) console.log(`   ${JSON.stringify(job.reason)}`);
			if (job.nextCheckAt)
				console.log(
					`   Next check: ${new Date(job.nextCheckAt).toISOString()}`,
				);
		}
	}
}
