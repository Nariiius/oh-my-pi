import { beforeEach, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	formatLimitTitle,
	formatResetCountdown,
	renderUsageProgressBar,
	UsagePanelComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/usage-panel";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

let testTheme: Awaited<ReturnType<typeof getThemeByName>>;

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load theme for UsagePanel tests");
	}
	setThemeInstance(testTheme);
}

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

function makeMockTui(): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return {
		tui: {
			terminal: { rows: 40, columns: 100 },
			requestRender,
		} as unknown as TUI,
		requestRender,
	};
}

const SAMPLE_REPORTS: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: Date.now() - 60_000,
		limits: [
			{
				id: "primary",
				label: "5-hour window",
				scope: { provider: "openai-codex" },
				window: {
					id: "primary",
					label: "5-hour window",
					durationMs: 5 * 3600 * 1000,
					resetsAt: Date.now() + 7200 * 1000,
				},
				amount: {
					used: 40,
					limit: 100,
					unit: "percent",
					usedFraction: 0.4,
				},
			},
			{
				id: "secondary",
				label: "Weekly window",
				scope: { provider: "openai-codex" },
				window: {
					id: "secondary",
					label: "Weekly window",
					durationMs: 7 * 24 * 3600 * 1000,
					resetsAt: Date.now() + 86400 * 1000,
				},
				amount: {
					used: 85,
					limit: 100,
					unit: "percent",
					usedFraction: 0.85,
				},
			},
		],
		resetCredits: {
			availableCount: 2,
			credits: [
				{
					expiresAt: new Date(Date.now() + 3 * 86400 * 1000).toISOString(),
				},
			],
		},
		metadata: {
			email: "dev@example.com",
			orgName: "Acme Corp",
		},
	},
	{
		provider: "anthropic",
		fetchedAt: Date.now() - 120_000,
		limits: [
			{
				id: "monthly",
				label: "Monthly quota",
				scope: { provider: "anthropic" },
				amount: {
					used: 950,
					limit: 1000,
					unit: "tokens",
					usedFraction: 0.95,
				},
			},
		],
		metadata: {
			email: "team@example.com",
		},
	},
];

describe("renderUsageProgressBar", () => {
	beforeEach(async () => {
		testTheme ??= await getThemeByName("dark");
		installTestTheme();
	});

	test("renders progress bar for low usage (<70%)", () => {
		const bar = stripVTControlCharacters(renderUsageProgressBar(0.3, 10));
		expect(bar).toContain("[███░░░░░░░] 30.0%");
	});

	test("renders progress bar for high usage (>90%)", () => {
		const bar = stripVTControlCharacters(renderUsageProgressBar(0.95, 10));
		expect(bar).toContain("[██████████] 95.0%");
	});

	test("handles undefined fraction gracefully", () => {
		const bar = stripVTControlCharacters(renderUsageProgressBar(undefined, 10));
		expect(bar).toContain("[░░░░░░░░░░] ?%");
	});

	test("formatLimitTitle combines descriptive label, tier, and window correctly", () => {
		expect(
			formatLimitTitle({
				id: "cursor:models",
				label: "Cursor Models",
				scope: { provider: "cursor" },
				window: { id: "monthly", label: "Monthly" },
				amount: { usedFraction: 0.5, unit: "percent" },
			}),
		).toBe("Cursor Models (Monthly)");

		expect(
			formatLimitTitle({
				id: "antigravity:claude",
				label: "Usage (Anthropic)",
				scope: { provider: "google-antigravity" },
				window: { id: "daily", label: "Daily" },
				amount: { usedFraction: 0.2, unit: "percent" },
			}),
		).toBe("Usage (Anthropic) (Daily)");
	});

	test("formatResetCountdown omits misleading resets now text", () => {
		const now = 1700000000000;
		// Future reset time:
		expect(formatResetCountdown(now + 3600000, now)).toBe(" · resets in 1h");
		// Past reset time (does NOT say resets now):
		expect(formatResetCountdown(now - 10000, now, { id: "monthly", label: "Monthly" })).toBe(" · resets monthly");
		expect(formatResetCountdown(now - 10000, now, { id: "daily", label: "Daily" })).toBe(" · resets daily");
		expect(formatResetCountdown(undefined, now)).toBe("");
	});
});

describe("UsagePanelComponent", () => {
	beforeEach(async () => {
		testTheme ??= await getThemeByName("dark");
		installTestTheme();
	});

	test("renders usage reports with provider, account, meters and reset credits", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
				currentProvider: "openai-codex",
				activeAccount: { email: "dev@example.com" },
				usageModelSelectors: ["openai-codex/gpt-5.6-sol"],
			},
			{ onClose },
		);

		const rendered = normalize(panel.render(100));
		expect(rendered).toContain("Usage & Quota");
		expect(rendered).toContain("OPENAI-CODEX [active provider]");
		expect(rendered).toContain("dev@example.com (Acme Corp) ● ACTIVE");
		expect(rendered).toContain("5-hour window");
		expect(rendered).toContain("Weekly window");
		expect(rendered).toContain("Saved Resets: 2 available");
		expect(rendered).toContain("ANTHROPIC");
		expect(rendered).toContain("Monthly quota");
	});

	test("collapses and expands provider on space/Enter", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose },
		);

		// Cursor starts at first line (OPENAI-CODEX header)
		let text = normalize(panel.render(100));
		expect(text).toContain("dev@example.com");

		// Press space to collapse OPENAI-CODEX
		panel.handleInput(" ");
		text = normalize(panel.render(100));
		expect(text).not.toContain("dev@example.com");
		expect(text).toContain("OPENAI-CODEX");

		// Press space again to expand
		panel.handleInput(" ");
		text = normalize(panel.render(100));
		expect(text).toContain("dev@example.com");
	});

	test("filters reports interactively", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose },
		);

		panel.handleInput("/");
		panel.handleInput("a");
		panel.handleInput("n");
		panel.handleInput("t");
		panel.handleInput("h");

		const text = normalize(panel.render(100));
		expect(text).toContain("ANTHROPIC");
		expect(text).not.toContain("OPENAI-CODEX");
	});

	test("refreshes reports on r key", async () => {
		const { tui, requestRender } = makeMockTui();
		const onClose = vi.fn();
		const fetchUsageReports = vi.fn().mockResolvedValue([
			{
				provider: "refreshed-provider",
				fetchedAt: Date.now(),
				limits: [],
			},
		]);

		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
				fetchUsageReports,
			},
			{ onClose },
		);

		panel.handleInput("r");
		await Promise.resolve();
		await Promise.resolve();

		expect(fetchUsageReports).toHaveBeenCalled();
		const text = normalize(panel.render(100));
		expect(text).toContain("REFRESHED-PROVIDER");
		panel.dispose();
	});

	test("closes on Esc or q", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose },
		);

		panel.handleInput("q");
		expect(onClose).toHaveBeenCalled();
	});

	test("closes on Escape key and Kitty protocol Escape sequence", () => {
		const { tui } = makeMockTui();
		const onClose1 = vi.fn();
		const panel1 = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose: onClose1 },
		);
		panel1.handleInput("\x1b");
		expect(onClose1).toHaveBeenCalled();

		const onClose2 = vi.fn();
		const panel2 = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose: onClose2 },
		);
		panel2.handleInput("\x1b[27;1u"); // Kitty protocol escape
		expect(onClose2).toHaveBeenCalled();
	});

	test("renders API key providers with configured models and session usage", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: [],
				apiKeyProviders: [
					{
						provider: "agentrouter",
						apiKeyConfigured: true,
						active: true,
						models: [
							{ id: "deepseek-v4-flash", contextWindow: 1048576, cost: { input: 0.14, output: 0.28 } },
							{ id: "glm-5.3", contextWindow: 1048576, cost: { input: 1.4, output: 4.4 } },
						],
						sessionUsage: {
							inputTokens: 10000,
							outputTokens: 2000,
							cost: 0.005,
						},
					},
				],
			},
			{ onClose },
		);

		const rendered = normalize(panel.render(100));
		expect(rendered).toContain("AGENTROUTER [api key] [active provider]");
		expect(rendered).toContain("deepseek-v4-flash (1049k context · in: $0.14/M, out: $0.28/M)");
		expect(rendered).toContain("glm-5.3 (1049k context · in: $1.4/M, out: $4.4/M)");
		expect(rendered).toContain("Session Usage: 12.0k tokens · $0.0050 spend");
	});

	test("supports mouse wheel and page scrolling in usage panel", () => {
		const { tui } = makeMockTui();
		const onClose = vi.fn();
		const panel = new UsagePanelComponent(
			tui,
			{
				reports: SAMPLE_REPORTS,
			},
			{ onClose },
		);

		// Mouse wheel down
		panel.handleInput("\x1b[<65;10;10M");
		// Page down
		panel.handleInput("\x1b[6~");
		// Mouse wheel up
		panel.handleInput("\x1b[<64;10;10M");

		const rendered = normalize(panel.render(100));
		expect(rendered).toContain("Usage & Quota");
		expect(rendered).toContain("OPENAI-CODEX");
	});
});
