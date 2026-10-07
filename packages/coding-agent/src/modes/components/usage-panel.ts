/**
 * Interactive fullscreen Usage & Quota panel for `/usage`.
 *
 * Displays live usage metrics, rolling quota windows (e.g. 5h, 7d),
 * rate limits, token spend, saved reset credits, and active session
 * account stickiness with interactive expand/collapse, visual progress bars,
 * filtering, and live refresh (`r`).
 */
import type { OAuthAccountIdentity, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai";
import { type Component, matchesKey, parseSgrMouse, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { clampSelection, renderScrollableList } from "./selector-helpers";
import { theme } from "../theme/theme";
import { bottomBorder, row, topBorder } from "./overlay-box";

export interface UsagePanelOptions {
	reports: UsageReport[];
	nowMs?: number;
	currentProvider?: string;
	activeAccount?: OAuthAccountIdentity;
	usageModelSelectors?: readonly string[];
	fetchUsageReports?: () => Promise<UsageReport[] | null>;
	apiKeyProviders?: ApiKeyProviderUsage[];
}

export interface ApiKeyProviderUsage {
	provider: string;
	apiKeyConfigured: boolean;
	active: boolean;
	models: Array<{
		id: string;
		name?: string;
		contextWindow?: number | null;
		cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	}>;
	sessionUsage?: {
		inputTokens: number;
		outputTokens: number;
		cost: number;
	};
}

export interface UsagePanelCallbacks {
	onClose: () => void | Promise<void>;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CHROME_ROWS = 4;
const MIN_VISIBLE = 6;
const FOOTER_HINT = "↑/↓ navigate · space expand · r refresh · / filter · Esc/q close";
const FILTER_FOOTER_HINT = "Type to filter · Enter apply · Esc clear filter";

/** Renders a visual segmented progress bar for quota / usage fractions. */
export function renderUsageProgressBar(
	fraction: number | undefined,
	width: number,
	uiTheme: typeof theme = theme,
): string {
	if (fraction === undefined || Number.isNaN(fraction)) {
		return uiTheme.fg("dim", `[${"░".repeat(Math.max(1, width))}] ?%`);
	}
	const clamped = Math.max(0, Math.min(1, fraction));
	const pct = (fraction * 100).toFixed(1);
	const barWidth = Math.max(4, width);
	const filled = Math.round(clamped * barWidth);
	const empty = Math.max(0, barWidth - filled);

	const color = fraction >= 0.9 ? "error" : fraction >= 0.7 ? "warning" : "success";
	const bar = uiTheme.fg(color, "█".repeat(filled)) + uiTheme.fg("dim", "░".repeat(empty));
	const pctText = uiTheme.fg(color, `${pct}%`);
	return `[${bar}] ${pctText}`;
}

function formatAmount(amount: UsageLimit["amount"]): string {
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		const unit = amount.unit ? ` ${amount.unit}` : "";
		return `${amount.used.toLocaleString()}/${amount.limit.toLocaleString()}${unit}`;
	}
	if (amount.used !== undefined) {
		const unit = amount.unit ? ` ${amount.unit}` : "";
		return `${amount.used.toLocaleString()}${unit}`;
	}
	if (amount.usedFraction !== undefined) {
		return `${(amount.usedFraction * 100).toFixed(1)}%`;
	}
	if (amount.remainingFraction !== undefined) {
		return `${((1 - amount.remainingFraction) * 100).toFixed(1)}%`;
	}
	return "";
}

export function formatLimitTitle(limit: UsageLimit): string {
	const label = limit.label?.trim() || "";
	const windowLabel = limit.window?.label?.trim() || "";
	const tier = limit.scope.tier?.trim() || "";

	let title = label || limit.id;
	if (title === "Usage" && limit.scope.provider) {
		title = `${limit.scope.provider} Quota`;
	}
	if (tier && !title.toLowerCase().includes(tier.toLowerCase())) {
		title = `${title} (${tier})`;
	}
	if (
		windowLabel &&
		!title.toLowerCase().includes(windowLabel.toLowerCase()) &&
		windowLabel.toLowerCase() !== "default" &&
		windowLabel.toLowerCase() !== "quota window"
	) {
		title = `${title} (${windowLabel})`;
	}
	return title;
}

export function formatResetCountdown(
	resetsAtMs: number | undefined,
	nowMs: number,
	window?: UsageLimit["window"],
): string {
	if (resetsAtMs !== undefined && !Number.isNaN(resetsAtMs) && resetsAtMs > nowMs) {
		const delta = resetsAtMs - nowMs;
		return ` · resets in ${formatDuration(delta)}`;
	}
	if (window?.id === "daily" || window?.label?.toLowerCase() === "daily") {
		return " · resets daily";
	}
	if (window?.id === "weekly" || window?.label?.toLowerCase() === "weekly") {
		return " · resets weekly";
	}
	if (window?.id === "monthly" || window?.label?.toLowerCase() === "monthly") {
		return " · resets monthly";
	}
	return "";
}

interface DisplayLine {
	text: string;
	provider?: string;
	isHeader?: boolean;
	canToggle?: boolean;
}

export class UsagePanelComponent implements Component {
	#tui: TUI;
	#reports: UsageReport[];
	#nowMs: number;
	#currentProvider?: string;
	#activeAccount?: OAuthAccountIdentity;
	#usageModelSelectors: readonly string[];
	#fetchUsageReports?: () => Promise<UsageReport[] | null>;
	#apiKeyProviders: ApiKeyProviderUsage[];
	#onClose: () => void | Promise<void>;

	#cursor = 0;
	#scrollStart = 0;
	#filterQuery = "";
	#isFiltering = false;
	#isRefreshing = false;
	#spinnerFrame = 0;
	#spinnerTimer: NodeJS.Timeout | undefined;
	#collapsedProviders = new Set<string>();
	#collapsedAccounts = new Set<string>();
	#closed = false;

	constructor(tui: TUI, options: UsagePanelOptions, callbacks: UsagePanelCallbacks) {
		this.#tui = tui;
		this.#reports = options.reports;
		this.#nowMs = options.nowMs ?? Date.now();
		this.#currentProvider = options.currentProvider;
		this.#activeAccount = options.activeAccount;
		this.#usageModelSelectors = options.usageModelSelectors ?? [];
		this.#fetchUsageReports = options.fetchUsageReports;
		this.#apiKeyProviders = options.apiKeyProviders ?? [];
		this.#onClose = callbacks.onClose;
	}

	setReports(reports: UsageReport[]): void {
		this.#reports = reports;
		this.#nowMs = Date.now();
		this.#tui.requestRender();
	}

	async refresh(): Promise<void> {
		if (this.#isRefreshing || !this.#fetchUsageReports) return;
		this.#isRefreshing = true;
		this.#startSpinner();
		this.#tui.requestRender();
		try {
			const fresh = await this.#fetchUsageReports();
			if (fresh && fresh.length > 0) {
				this.#reports = fresh;
				this.#nowMs = Date.now();
			}
		} finally {
			this.#isRefreshing = false;
			this.#stopSpinner();
			this.#tui.requestRender();
		}
	}

	#startSpinner(): void {
		this.#stopSpinner();
		this.#spinnerTimer = setInterval(() => {
			if (this.#closed || !this.#isRefreshing) return;
			this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.#tui.requestRender();
		}, 100);
	}

	#stopSpinner(): void {
		if (this.#spinnerTimer) {
			clearInterval(this.#spinnerTimer);
			this.#spinnerTimer = undefined;
		}
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#stopSpinner();
		await this.#onClose();
	}

	#buildLines(width: number): DisplayLine[] {
		const lines: DisplayLine[] = [];
		const meterWidth = Math.max(10, Math.min(24, Math.floor(width / 4)));

		// Group reports by provider
		const grouped = new Map<string, UsageReport[]>();
		for (const report of this.#reports) {
			const list = grouped.get(report.provider) ?? [];
			list.push(report);
			grouped.set(report.provider, list);
		}

		const query = this.#filterQuery.trim().toLowerCase();

		for (const [provider, providerReports] of grouped) {
			if (query && !provider.toLowerCase().includes(query)) {
				// Check if any email / metadata matches
				const anyMatch = providerReports.some(r => {
					const email = typeof r.metadata?.email === "string" ? r.metadata.email.toLowerCase() : "";
					return email.includes(query);
				});
				if (!anyMatch) continue;
			}

			const isProviderCollapsed = this.#collapsedProviders.has(provider);
			const providerCollapseMark = isProviderCollapsed ? "▸" : "▾";
			const isActiveProvider = this.#currentProvider === provider;
			const providerHeader = `${theme.fg("accent", providerCollapseMark)} ${theme.bold(theme.fg("accent", provider.toUpperCase()))}${isActiveProvider ? theme.fg("success", " [active provider]") : ""}`;

			lines.push({
				text: providerHeader,
				provider,
				isHeader: true,
				canToggle: true,
			});

			if (isProviderCollapsed) continue;

			// Provider notes
			const providerNotes = [...new Set(providerReports.flatMap(r => r.notes ?? []))];
			for (const note of providerNotes) {
				lines.push({ text: `  ${theme.fg("dim", `ℹ ${note}`)}`, provider });
			}

			// Models with usage data
			const reportingModels = this.#usageModelSelectors.filter(s => s.startsWith(`${provider}/`));
			if (reportingModels.length > 0) {
				lines.push({ text: `  ${theme.fg("dim", "Models with usage reporting:")}`, provider });
				for (const sel of reportingModels) {
					lines.push({ text: `    ${theme.fg("muted", sel)}`, provider });
				}
			}

			// Per-account details
			for (let i = 0; i < providerReports.length; i++) {
				const report = providerReports[i]!;
				const email = typeof report.metadata?.email === "string" ? report.metadata.email : undefined;
				const accountId = typeof report.metadata?.accountId === "string" ? report.metadata.accountId : undefined;
				const orgName = typeof report.metadata?.orgName === "string" ? report.metadata.orgName : undefined;
				const accountKey = `${provider}:${email || accountId || i}`;
				const isAccountCollapsed = this.#collapsedAccounts.has(accountKey);

				const isActiveAccount =
					this.#activeAccount &&
					((email && this.#activeAccount.email === email) ||
						(accountId && this.#activeAccount.accountId === accountId));

				const accountLabel = email || accountId || `Account #${i + 1}`;
				const orgSuffix = orgName ? ` (${orgName})` : "";
				const activeBadge = isActiveAccount ? ` ${theme.fg("success", "● ACTIVE")}` : "";

				lines.push({
					text: `  ${theme.fg("accent", isAccountCollapsed ? "▸" : "▾")} ${theme.bold(accountLabel)}${theme.fg("dim", orgSuffix)}${activeBadge}`,
					provider,
					canToggle: true,
				});

				if (isAccountCollapsed) continue;

				// Saved Reset Credits
				const resetCredits = report.resetCredits;
				if (resetCredits && resetCredits.availableCount > 0) {
					lines.push({
						text: `    ${theme.fg("accent", "⚡")} Saved Resets: ${theme.bold(String(resetCredits.availableCount))} available`,
						provider,
					});
					if (resetCredits.credits) {
						for (const cred of resetCredits.credits) {
							if (cred.expiresAt) {
								const expMs = Date.parse(cred.expiresAt);
								const expText = !Number.isNaN(expMs)
									? formatResetCountdown(expMs, this.#nowMs)
									: cred.expiresAt;
								lines.push({
									text: `      ${theme.fg("dim", `• 1 credit (${expText})`)}`,
									provider,
								});
							}
						}
					}
				}

				// Limits / Windows
				if (report.limits.length === 0) {
					lines.push({ text: `    ${theme.fg("dim", "No active rate limits recorded")}`, provider });
				} else {
					for (const limit of report.limits) {
						const fraction = resolveUsedFraction(limit);
						const bar = renderUsageProgressBar(fraction, meterWidth, theme);
						const limitTitle = formatLimitTitle(limit);
						const amountStr = formatAmount(limit.amount);
						const resetsAtMs =
							limit.window?.resetsAt !== undefined
								? typeof limit.window.resetsAt === "number"
									? limit.window.resetsAt
									: Date.parse(String(limit.window.resetsAt))
								: undefined;
						const resetStr = formatResetCountdown(resetsAtMs, this.#nowMs, limit.window);

						lines.push({
							text: `    ${theme.bold(limitTitle)}: ${bar} ${theme.fg("dim", amountStr)}${theme.fg("dim", resetStr)}`,
							provider,
						});

						// Per-limit notes
						if (limit.notes && limit.notes.length > 0) {
							for (const note of limit.notes) {
								lines.push({ text: `      ${theme.fg("dim", `• ${note}`)}`, provider });
							}
						}
					}
				}
			}

			lines.push({ text: "", provider });
		}

		// API Key providers (e.g. GMI, NVIDIA, DeepSeek, AgentRouter, etc.)
		const reportedProviders = new Set(this.#reports.map(r => r.provider.toLowerCase()));
		const filteredApiProviders = this.#apiKeyProviders.filter(p => !reportedProviders.has(p.provider.toLowerCase()));

		for (const apiProv of filteredApiProviders) {
			const provider = apiProv.provider;
			if (query && !provider.toLowerCase().includes(query)) {
				const modelMatch = apiProv.models.some(m => m.id.toLowerCase().includes(query));
				if (!modelMatch) continue;
			}

			const isProviderCollapsed = this.#collapsedProviders.has(provider);
			const providerCollapseMark = isProviderCollapsed ? "▸" : "▾";
			const isActive = apiProv.active || this.#currentProvider === provider;
			const activeBadge = isActive ? theme.fg("success", " [active provider]") : "";
			const keyBadge = apiProv.apiKeyConfigured ? theme.fg("accent", " [api key]") : theme.fg("dim", " [keyless]");
			const providerHeader = `${theme.fg("accent", providerCollapseMark)} ${theme.bold(theme.fg("accent", provider.toUpperCase()))}${keyBadge}${activeBadge}`;

			lines.push({
				text: providerHeader,
				provider,
				isHeader: true,
				canToggle: true,
			});

			if (isProviderCollapsed) continue;

			if (apiProv.models.length > 0) {
				lines.push({ text: `  ${theme.fg("dim", "Configured Models:")}`, provider });
				for (const model of apiProv.models) {
					const contextStr = model.contextWindow
						? `${Math.round(model.contextWindow / 1000)}k context`
						: undefined;
					const costStr =
						model.cost && (model.cost.input > 0 || model.cost.output > 0)
							? `in: $${model.cost.input}/M, out: $${model.cost.output}/M`
							: undefined;
					const metaParts = [contextStr, costStr].filter(Boolean).join(" · ");
					const metaSuffix = metaParts ? theme.fg("dim", ` (${metaParts})`) : "";
					lines.push({ text: `    • ${theme.bold(model.id)}${metaSuffix}`, provider });
				}
			}

			if (
				apiProv.sessionUsage &&
				(apiProv.sessionUsage.inputTokens > 0 ||
					apiProv.sessionUsage.outputTokens > 0 ||
					apiProv.sessionUsage.cost > 0)
			) {
				const totalTokens = apiProv.sessionUsage.inputTokens + apiProv.sessionUsage.outputTokens;
				const tokensStr = totalTokens < 1000 ? `${totalTokens}` : `${(totalTokens / 1000).toFixed(1)}k`;
				lines.push({
					text: `  ${theme.fg("dim", "Session Usage:")} ${theme.fg("success", `${tokensStr} tokens`)} · ${theme.fg("success", `$${apiProv.sessionUsage.cost.toFixed(4)} spend`)}`,
					provider,
				});
			}

			lines.push({ text: "", provider });
		}

		if (lines.length === 0) {
			lines.push({
				text: theme.fg("muted", query ? `No usage records match "${query}"` : "No usage data available."),
			});
		}

		return lines;
	}

	#move(delta: number, totalRows: number): void {
		const next = Math.min(Math.max(0, this.#cursor + delta), Math.max(0, totalRows - 1));
		if (next === this.#cursor) return;
		this.#cursor = next;
		this.#tui.requestRender();
	}

	#toggleRow(lines: DisplayLine[]): void {
		const current = lines[this.#cursor];
		if (!current || !current.canToggle || !current.provider) return;

		if (current.isHeader) {
			if (this.#collapsedProviders.has(current.provider)) {
				this.#collapsedProviders.delete(current.provider);
			} else {
				this.#collapsedProviders.add(current.provider);
			}
		}
		this.#tui.requestRender();
	}

	handleInput(data: string): void {
		const lines = this.#buildLines(80);

		// Route SGR mouse wheel events for trackpad / mouse scrolling
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event?.wheel === -1) {
				this.#move(-3, lines.length);
				return;
			}
			if (event?.wheel === 1) {
				this.#move(3, lines.length);
				return;
			}
			return;
		}

		if (this.#isFiltering) {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "escape") ||
				matchesKey(data, "esc") ||
				data === "\r" ||
				data === "\n" ||
				data === "\x1b"
			) {
				this.#isFiltering = false;
				this.#tui.requestRender();
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
				this.#filterQuery = this.#filterQuery.slice(0, -1);
				this.#cursor = 0;
				this.#tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " ") {
				this.#filterQuery += data;
				this.#cursor = 0;
				this.#tui.requestRender();
				return;
			}
			return;
		}

		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "esc") ||
			matchesKey(data, "q") ||
			data === "q" ||
			data === "Q" ||
			data === "\x1b"
		) {
			void this.#close();
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "k") || data === "\x1b[A") {
			this.#move(-1, lines.length);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j") || data === "\x1b[B") {
			this.#move(1, lines.length);
			return;
		}
		if (matchesKey(data, "pageUp") || data === "\x1b[5~") {
			this.#move(-10, lines.length);
			return;
		}
		if (matchesKey(data, "pageDown") || data === "\x1b[6~") {
			this.#move(10, lines.length);
			return;
		}
		if (matchesKey(data, "home")) {
			this.#cursor = 0;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.#cursor = Math.max(0, lines.length - 1);
			this.#tui.requestRender();
			return;
		}
		if (
			matchesKey(data, "space") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === " " ||
			data === "\r" ||
			data === "\n"
		) {
			this.#toggleRow(lines);
			return;
		}
		if (matchesKey(data, "r") || data === "r" || data === "R") {
			void this.refresh();
			return;
		}
		if (data === "/") {
			this.#isFiltering = true;
			this.#tui.requestRender();
			return;
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.#closed = true;
		this.#stopSpinner();
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.max(MIN_VISIBLE, termRows - CHROME_ROWS);

		const lines = this.#buildLines(width);
		const { selectedIndex, scrollOffset } = clampSelection(this.#cursor, this.#scrollStart, lines.length, listBudget);
		this.#cursor = selectedIndex;
		this.#scrollStart = scrollOffset;

		const out: string[] = [];
		out.push(topBorder(width, "Usage & Quota"));

		// Header status
		const latestFetchedAt = Math.max(0, ...this.#reports.map(r => r.fetchedAt ?? 0));
		const ageText = latestFetchedAt > 0 ? `${formatDuration(this.#nowMs - latestFetchedAt)} ago` : "just now";
		const refreshIndicator = this.#isRefreshing
			? ` · ${theme.fg("accent", `${SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length]} refreshing live data…`)}`
			: "";
		const filterIndicator = this.#filterQuery ? ` · filter: "${this.#filterQuery}"` : "";
		const headerStatus = ` Fetched: ${ageText}${refreshIndicator}${filterIndicator}`;
		out.push(row(theme.fg("muted", headerStatus), width));

		const renderedRowStrings: string[] = [];
		for (let rowIndex = scrollOffset; rowIndex < Math.min(lines.length, scrollOffset + listBudget); rowIndex++) {
			const item = lines[rowIndex]!;
			const isSelected = rowIndex === this.#cursor;
			const cursorMark = isSelected ? theme.fg("accent", "› ") : "  ";
			renderedRowStrings.push(`${cursorMark}${item.text}`);
		}

		const scrollableRows = renderScrollableList(renderedRowStrings, {
			width: width - 2,
			totalRows: lines.length,
			scrollOffset,
		});
		for (const sRow of scrollableRows) {
			out.push(row(sRow, width));
		}
		for (let i = scrollableRows.length; i < listBudget; i++) {
			out.push(row("", width));
		}

		// Footer
		const footerText = this.#isFiltering ? FILTER_FOOTER_HINT : FOOTER_HINT;
		out.push(row(theme.fg("dim", ` ${footerText}`), width));
		out.push(bottomBorder(width));

		return out;
	}
}
