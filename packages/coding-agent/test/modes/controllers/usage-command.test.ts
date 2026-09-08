import { beforeAll, describe, expect, it, mock } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("opens interactive UsagePanelComponent overlay and closes cleanly without crashing", async () => {
		let capturedPanel: { handleInput: (data: string) => void } | undefined;
		const setFocus = mock();
		const requestRender = mock();
		const hideOverlay = mock();
		const editor = { name: "editor" };
		const showOverlay = mock((panel: unknown) => {
			capturedPanel = panel as { handleInput: (data: string) => void };
			return { hide: hideOverlay };
		});

		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [],
			},
		];

		const ctx = {
			session: {
				fetchUsageReports: mock(async () => reports),
				getUsageReportingModelSelectors: () => [],
				modelRegistry: {
					getAvailable: () => [],
					authStorage: { getOAuthAccountIdentity: () => undefined },
				},
			},
			editor,
			editorContainer: { children: [editor] },
			ui: {
				terminal: { columns: 100, rows: 40 },
				showOverlay,
				setFocus,
				requestRender,
			},
			showWarning: mock(),
			showError: mock(),
		} as unknown as InteractiveModeContext;

		const controller = new CommandController(ctx);
		await controller.handleUsageCommand();

		expect(showOverlay).toHaveBeenCalledTimes(1);
		expect(capturedPanel).toBeDefined();

		// Simulate pressing q to close the overlay
		capturedPanel?.handleInput("q");

		expect(hideOverlay).toHaveBeenCalledTimes(1);
		expect(setFocus).toHaveBeenCalledWith(editor);
		expect(requestRender).toHaveBeenCalled();
	});
});
