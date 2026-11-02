/**
 * Session Limit - session-wide budget on three axes: cost, active time and output tokens.
 *
 * The extension is OFF by default. Limits are set with /limit and apply to the whole session
 * (every prompt and automatic turn, until /limit stop or a new session):
 *
 *   /limit cost 0.50      maximum cost in US$
 *   /limit time 30        maximum active time in minutes (only counts while the agent runs)
 *   /limit tokens 200000  output tokens (accepts 200k)
 *   /limit stop           disables it, clears the limits and restarts the budget
 *   /limit                shows the current state
 *
 * Running /limit <axis> <value> again while limits are active restarts the budget (usage
 * reset to zero), so the same command doubles as "start this limit again".
 *
 * The form with arguments also works when the client sends the text as a plain message
 * (T3, for example, only dispatches a command when the message is exactly the command name):
 * the `input` hook recognizes "/limit ..." and runs it without reaching the model.
 *
 * The budget starts counting when the first limit is set. On every turn the model receives a
 * [session-budget] note with what is left; when a limit is exhausted, new tool calls and new
 * prompts are blocked and the turn is aborted.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "session-limit";

type Axis = "cost" | "time" | "tokens";

interface Limits {
	/** US$ per session. */
	cost?: number;
	/** Minutes of active time per session. */
	time?: number;
	/** Output tokens per session. */
	tokens?: number;
}

interface SessionBudget {
	/** When the budget started counting. */
	startedAt: number;
	/** Active time already accumulated (finished runs). */
	activeMs: number;
	/** Start of the run in progress, when there is one. */
	runningSince?: number;
	cost: number;
	outputTokens: number;
	/** Reason for the block, once a limit is exhausted. */
	stopped?: string;
}

interface LimitView {
	cost?: { used: number; limit: number; left: number; over: boolean };
	time?: { usedMs: number; limitMs: number; leftMs: number; over: boolean };
	tokens?: { used: number; limit: number; left: number; over: boolean };
	over: Axis[];
}

const AXIS_LABEL: Record<Axis, string> = {
	cost: "cost",
	time: "time",
	tokens: "output tokens",
};

const AXIS_HINT: Record<Axis, string> = {
	cost: "Use /limit cost 0.50",
	time: "Use /limit time 30",
	tokens: "Use /limit tokens 200000",
};

const AXIS_ALIASES: Record<string, Axis> = {
	cost: "cost",
	usd: "cost",
	$: "cost",
	time: "time",
	min: "time",
	minutes: "time",
	tokens: "tokens",
	token: "tokens",
	tok: "tokens",
	output: "tokens",
};

const HELP = [
	"Usage: /limit <option> [value]",
	"",
	"  /limit cost 0.50      maximum session cost (US$)",
	"  /limit time 30        maximum session active time (minutes)",
	"  /limit tokens 200000  session output tokens (accepts 200k)",
	"  /limit stop           disables it, clears the limits and restarts the budget",
	"  /limit                shows the current state",
	"",
	"The budget is one per session and starts counting on the first /limit.",
	"Running /limit with a value again restarts it (usage reset to zero).",
	"The extension starts disabled in every session.",
].join("\n");

const limits: Limits = {};
let budget: SessionBudget | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastCtx: ExtensionContext | undefined;
let warnedMissingCost = false;

function enabled(): boolean {
	return limits.cost !== undefined || limits.time !== undefined || limits.tokens !== undefined;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function money(value: number): string {
	return `$${value.toFixed(4)}`;
}

function tokenCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function minutes(ms: number): string {
	return `${(ms / 60_000).toFixed(1)} min`;
}

function compactTokens(value: number): string {
	const rounded = Math.round(value);
	return rounded >= 1000 ? `${(rounded / 1000).toFixed(1)}k` : `${rounded}`;
}

function formatLimit(axis: Axis, value: number): string {
	if (axis === "cost") return money(value);
	if (axis === "time") return `${value.toFixed(value < 10 ? 1 : 0)} min`;
	return `${tokenCount(value)} tokens`;
}

function activeSummary(): string {
	const parts: string[] = [];
	if (limits.cost !== undefined) parts.push(`${AXIS_LABEL.cost} ${money(limits.cost)}`);
	if (limits.time !== undefined) parts.push(`${AXIS_LABEL.time} ${formatLimit("time", limits.time)}`);
	if (limits.tokens !== undefined) parts.push(`${AXIS_LABEL.tokens} ${tokenCount(limits.tokens)}`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Session budget
// ---------------------------------------------------------------------------

function elapsedActiveMs(now = Date.now()): number {
	if (!budget) return 0;
	return budget.activeMs + (budget.runningSince !== undefined ? now - budget.runningSince : 0);
}

function view(now = Date.now()): LimitView {
	const result: LimitView = { over: [] };

	if (limits.cost !== undefined) {
		const used = budget?.cost ?? 0;
		const left = limits.cost - used;
		result.cost = { used, limit: limits.cost, left: Math.max(0, left), over: left <= 0 };
	}
	if (limits.time !== undefined) {
		const limitMs = limits.time * 60_000;
		const usedMs = elapsedActiveMs(now);
		const leftMs = limitMs - usedMs;
		result.time = { usedMs, limitMs, leftMs: Math.max(0, leftMs), over: leftMs <= 0 };
	}
	if (limits.tokens !== undefined) {
		const used = budget?.outputTokens ?? 0;
		const left = limits.tokens - used;
		result.tokens = { used, limit: limits.tokens, left: Math.max(0, left), over: left <= 0 };
	}

	if (result.cost?.over) result.over.push("cost");
	if (result.time?.over) result.over.push("time");
	if (result.tokens?.over) result.over.push("tokens");
	return result;
}

function clearTimer(): void {
	if (timer !== undefined) {
		clearTimeout(timer);
		timer = undefined;
	}
}

function armTimer(ctx?: ExtensionContext): void {
	clearTimer();
	if (!budget || budget.stopped || !enabled() || limits.time === undefined) return;
	// Time only runs while the agent is working.
	if (budget.runningSince === undefined) return;

	const current = budget;
	const left = limits.time * 60_000 - elapsedActiveMs();
	const fire = () => {
		timer = undefined;
		if (budget !== current || current.stopped) return;
		stopIfNeeded(lastCtx ?? ctx, true);
	};

	if (left <= 0) {
		fire();
		return;
	}

	timer = setTimeout(fire, left);
	// Do not keep the process alive just because of the time limit.
	(timer as unknown as { unref?: () => void }).unref?.();
}

function resumeClock(ctx?: ExtensionContext): void {
	if (!budget || budget.stopped || budget.runningSince !== undefined) return;
	budget.runningSince = Date.now();
	armTimer(ctx);
}

function pauseClock(ctx?: ExtensionContext): void {
	if (!budget || budget.runningSince === undefined) return;
	budget.activeMs += Date.now() - budget.runningSince;
	budget.runningSince = undefined;
	clearTimer();
	updateStatus(ctx);
}

/** Keep the clock consistent with the real state (running or idle). */
function syncClock(ctx?: ExtensionContext): void {
	const running = ctx ? !ctx.isIdle() : false;
	if (running) resumeClock(ctx);
	else pauseClock(ctx);
}

function ensureBudget(): SessionBudget {
	if (!budget) {
		budget = { startedAt: Date.now(), activeMs: 0, cost: 0, outputTokens: 0 };
	}
	return budget;
}

/** Zero the accumulated usage and start counting now (new /limit with limits already set). */
function restartBudget(ctx?: ExtensionContext): void {
	clearTimer();
	budget = { startedAt: Date.now(), activeMs: 0, cost: 0, outputTokens: 0 };
	syncClock(ctx);
	armTimer(ctx);
	updateStatus(ctx);
}

function resetAll(): void {
	clearTimer();
	budget = undefined;
	delete limits.cost;
	delete limits.time;
	delete limits.tokens;
}

function updateStatus(ctx: ExtensionContext | undefined): void {
	if (!ctx) return;
	let text: string | undefined;

	if (enabled() && budget) {
		if (budget.stopped) {
			text = `⚖ session limit: STOPPED (${budget.stopped})`;
		} else {
			const current = view();
			const parts: string[] = [];
			if (current.cost) parts.push(`${money(current.cost.used)}/${money(current.cost.limit)}`);
			if (current.time) parts.push(`${minutes(current.time.usedMs)}/${minutes(current.time.limitMs)}`);
			if (current.tokens) {
				parts.push(`${compactTokens(current.tokens.used)}/${compactTokens(current.tokens.limit)} tok`);
			}
			text = `⚖ ${parts.join(" · ")}`;
		}
	}

	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Modes without UI (print/json) do not need the status.
	}
}

function notice(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		ctx?.ui.notify(message, type);
	} catch {
		// No UI: the information also goes to the model context.
	}
}

/**
 * Marks the session as blocked once a limit is exhausted.
 * `abort` interrupts the current turn; without `abort` it only blocks what comes next.
 */
function stopIfNeeded(ctx: ExtensionContext | undefined, abort: boolean): boolean {
	if (!budget || !enabled()) return false;

	if (!budget.stopped) {
		const over = view().over;
		if (over.length === 0) return false;
		budget.stopped = over.map((axis) => AXIS_LABEL[axis]).join(" + ");
		clearTimer();
		updateStatus(ctx);
		const tail = abort ? "Aborting the turn." : "New prompts and tools will be blocked.";
		notice(ctx, `Session budget exhausted (${budget.stopped}). ${tail}`, "warning");
	}

	if (abort) {
		try {
			ctx?.abort();
		} catch {
			// The signal may already be closed.
		}
	}
	return true;
}

/** Unblocks the session when the limits were raised above the usage already made. */
function releaseIfRecovered(ctx?: ExtensionContext): boolean {
	if (!budget?.stopped || !enabled()) return false;
	if (view().over.length > 0) return false;

	budget.stopped = undefined;
	armTimer(ctx);
	updateStatus(ctx);
	return true;
}

// ---------------------------------------------------------------------------
// Text sent to the model
// ---------------------------------------------------------------------------

function reminderText(): string {
	const current = view();
	const lines: string[] = ["[session-budget] remaining budget for this session:"];

	if (current.cost) {
		lines.push(
			`- cost: ${money(current.cost.used)} of ${money(current.cost.limit)} used, ${money(current.cost.left)} left`,
		);
	}
	if (current.time) {
		lines.push(
			`- time (active): ${minutes(current.time.usedMs)} of ${minutes(current.time.limitMs)} used, ${minutes(current.time.leftMs)} left`,
		);
	}
	if (current.tokens) {
		lines.push(
			`- output tokens: ${tokenCount(current.tokens.used)} of ${tokenCount(current.tokens.limit)} used, ${tokenCount(current.tokens.left)} left`,
		);
	}

	lines.push("");
	if (budget?.stopped) {
		lines.push(
			`The session budget is exhausted (${budget.stopped}). Do not call any tool. Reply with a short summary of what is done and what is unfinished, and stop.`,
		);
	} else {
		lines.push(
			"Keep working inside these limits: short answers, targeted steps, no long-running work you cannot finish. If a limit is about to run out, finish up and report what remains.",
		);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function costOfUsage(usage: UsageLike, ctx: ExtensionContext): number {
	const reported = usage.cost?.total;
	if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;

	const rates = ctx.model?.cost;
	if (!rates) return 0;

	const estimated =
		((usage.input ?? 0) * (rates.input ?? 0) +
			(usage.output ?? 0) * (rates.output ?? 0) +
			(usage.cacheRead ?? 0) * (rates.cacheRead ?? 0) +
			(usage.cacheWrite ?? 0) * (rates.cacheWrite ?? 0)) /
		1_000_000;
	return Number.isFinite(estimated) ? estimated : 0;
}

// ---------------------------------------------------------------------------
// /limit command
// ---------------------------------------------------------------------------

function parseAmountForAxis(axis: Axis, raw: string): number | undefined {
	let text = raw.trim().toLowerCase().replace(",", ".");

	if (axis === "time") text = text.replace(/\s*(min|mins|minute|minutes)$/, "");
	if (axis === "tokens") text = text.replace(/\s*(tokens?|tok|tk)$/, "");
	if (axis === "cost") text = text.replace(/^(us\$|\$)/, "").replace(/\s*(usd|dollars?)$/, "");

	const match = /^([0-9]+(?:\.[0-9]+)?)([km])?$/.exec(text);
	if (!match) return undefined;

	const base = Number(match[1]);
	const multiplier = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : 1;
	const value = base * multiplier;
	if (!Number.isFinite(value) || value <= 0) return undefined;

	return axis === "tokens" ? Math.max(1, Math.round(value)) : value;
}

function statusReport(): string {
	const lines: string[] = [enabled() ? "Session limits: ACTIVE" : "Session limits: DISABLED"];

	if (!enabled()) {
		lines.push("");
		lines.push("No limits set.");
		lines.push("");
		lines.push("  /limit cost 0.50");
		lines.push("  /limit time 30");
		lines.push("  /limit tokens 200000");
		lines.push("  /limit stop");
		return lines.join("\n");
	}

	const current = view();
	const axisLine = (label: string, value: string | undefined) =>
		value === undefined ? `- ${label}: no limit` : `- ${label}: ${value}`;

	lines.push("");
	lines.push(
		axisLine(
			"cost",
			current.cost
				? `${money(current.cost.limit)} · used ${money(current.cost.used)} · left ${money(current.cost.left)}`
				: undefined,
		),
	);
	lines.push(
		axisLine(
			"active time",
			current.time
				? `${minutes(current.time.limitMs)} · used ${minutes(current.time.usedMs)} · left ${minutes(current.time.leftMs)}`
				: undefined,
		),
	);
	lines.push(
		axisLine(
			"output tokens",
			current.tokens
				? `${tokenCount(current.tokens.limit)} · used ${tokenCount(current.tokens.used)} · left ${tokenCount(current.tokens.left)}`
				: undefined,
		),
	);

	lines.push("");
	if (!budget) {
		lines.push("The budget starts counting on the first /limit.");
	} else {
		const started = new Date(budget.startedAt).toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
		});
		lines.push(
			budget.stopped
				? `Session BLOCKED by ${budget.stopped} since ${started}. Raise a limit to unblock.`
				: `Session budget counting since ${started}.`,
		);
	}
	lines.push("Use /limit stop to disable it and restart the budget.");
	return lines.join("\n");
}

/**
 * Recognizes "/limit ..." sent as a plain message. Clients such as T3 only dispatch a command
 * when the text is exactly the name, so the form with arguments arrives as a prompt.
 */
function matchLimitCommand(text: string): string | undefined {
	const match = /^\/limit(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match ? (match[1] ?? "").trim() : undefined;
}

async function handleLimitCommand(args: string, ctx: ExtensionContext): Promise<void> {
	lastCtx = ctx;
	const normalized = args.trim();
	const [rawAxis, ...rest] = normalized.split(/\s+/);
	const axisRaw = (rawAxis ?? "").toLowerCase();
	const valueRaw = rest.join(" ").trim();

	if (!axisRaw || axisRaw === "status" || axisRaw === "show") {
		notice(ctx, statusReport(), "info");
		return;
	}

	if (axisRaw === "stop" || axisRaw === "off" || axisRaw === "disable") {
		resetAll();
		updateStatus(ctx);
		notice(ctx, "Session limits disabled. The budget restarts on the next /limit.", "info");
		return;
	}

	if (axisRaw === "help" || axisRaw === "?" || axisRaw === "--help") {
		notice(ctx, HELP, "info");
		return;
	}

	const axis = AXIS_ALIASES[axisRaw];
	if (!axis) {
		notice(ctx, `Unknown option: ${axisRaw}\n\n${HELP}`, "error");
		return;
	}

	if (!valueRaw) {
		const current = limits[axis];
		notice(
			ctx,
			current === undefined
				? `No ${AXIS_LABEL[axis]} limit set. ${AXIS_HINT[axis]}`
				: `${AXIS_LABEL[axis]} limit: ${formatLimit(axis, current)} per session. ${AXIS_HINT[axis]}`,
			"info",
		);
		return;
	}

	if (/^(off|none|clear|0)$/i.test(valueRaw)) {
		delete limits[axis];
		if (!enabled()) {
			resetAll();
			updateStatus(ctx);
			notice(ctx, `${AXIS_LABEL[axis]} limit removed. No active limits: extension disabled.`, "info");
			return;
		}
		syncClock(ctx);
		const released = releaseIfRecovered(ctx);
		updateStatus(ctx);
		const suffix = released ? "\nSession budget unblocked." : "";
		notice(ctx, `${AXIS_LABEL[axis]} limit removed. Active: ${activeSummary()}.${suffix}`, "info");
		return;
	}

	const amount = parseAmountForAxis(axis, valueRaw);
	if (amount === undefined) {
		notice(ctx, `Invalid value for ${AXIS_LABEL[axis]}: "${valueRaw}".\n${AXIS_HINT[axis]}`, "error");
		return;
	}

	// Running /limit again while limits are active restarts the session budget.
	const alreadyEnabled = enabled();
	limits[axis] = amount;

	if (alreadyEnabled) {
		restartBudget(ctx);
	} else {
		ensureBudget();
		syncClock(ctx);
		armTimer(ctx);
	}
	updateStatus(ctx);

	const running = budget ? budget.runningSince !== undefined : false;
	const scopeNote = alreadyEnabled
		? "Session budget restarted (usage reset)."
		: running
			? "Applied to the running session."
			: "Effective from now.";
	notice(
		ctx,
		`${AXIS_LABEL[axis]} limit set: ${formatLimit(axis, amount)} per session.\nActive: ${activeSummary()}. ${scopeNote}`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sessionLimit(pi: ExtensionAPI) {
	// Every session starts with no limits: the extension only turns on through /limit.
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		resetAll();
		warnedMissingCost = false;
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
	});

	// Active time: only counts while the agent is working.
	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		resumeClock(ctx);
		updateStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		pauseClock(ctx);
		updateStatus(ctx);
	});

	// Budget note appended to the end of every request (one per turn, never persisted).
	pi.on("context", (event, ctx) => {
		lastCtx = ctx;
		if (!enabled() || !budget) return;

		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "session-limit",
					content: reminderText(),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	// Accounts the cost and output tokens of every finalized message.
	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!budget || !enabled()) return;

		const message = event.message as unknown as {
			role?: string;
			usage?: UsageLike;
			content?: Array<{ type?: string }>;
		};
		const usage = message.usage;
		if (!usage) return;
		if (message.role !== "assistant" && message.role !== "toolResult") return;

		const cost = costOfUsage(usage, ctx);
		if (
			message.role === "assistant" &&
			limits.cost !== undefined &&
			cost <= 0 &&
			(usage.output ?? 0) > 0 &&
			!warnedMissingCost
		) {
			warnedMissingCost = true;
			notice(ctx, "The provider did not report a dollar cost; the cost limit may not count this model.", "warning");
		}

		budget.cost += cost;
		budget.outputTokens += usage.output ?? 0;
		updateStatus(ctx);

		const wantsMoreTools =
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block?.type === "toolCall");

		stopIfNeeded(ctx, wantsMoreTools);
	});

	// With the budget exhausted no tool runs anymore.
	pi.on("tool_call", async (_event, ctx) => {
		lastCtx = ctx;
		if (!budget || !enabled()) return;

		if (!budget.stopped) stopIfNeeded(ctx, false);
		if (!budget.stopped) return;

		return {
			block: true,
			terminate: true,
			reason: `[session-budget] Session budget exhausted (${budget.stopped}). Do not call tools. Reply with a short summary of what is done and what remains, then stop.`,
		};
	});

	// Two roles:
	// 1) accept "/limit ..." typed as a plain message - clients such as T3 only dispatch a
	//    command when the message is exactly the name, so "/limit time 1" would become a prompt;
	// 2) block prompts once the session budget is exhausted.
	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") return { action: "continue" as const };

		const commandArgs = matchLimitCommand(event.text);
		if (commandArgs !== undefined) {
			await handleLimitCommand(commandArgs, ctx);
			return { action: "handled" as const };
		}

		if (!budget || !enabled()) return { action: "continue" as const };

		if (!budget.stopped) stopIfNeeded(ctx, false);
		if (!budget.stopped) return { action: "continue" as const };

		notice(
			ctx,
			`Session budget exhausted (${budget.stopped}). Raise a limit with /limit or disable it with /limit stop.`,
			"warning",
		);
		return { action: "handled" as const };
	});

	pi.registerCommand("limit", {
		description: "Limit session cost, active time and output tokens (off by default)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "cost ", label: "cost", description: "maximum session cost in US$" },
				{ value: "time ", label: "time", description: "maximum session active time in minutes" },
				{ value: "tokens ", label: "tokens", description: "session output tokens" },
				{ value: "status", label: "status", description: "shows the current limits" },
				{ value: "stop", label: "stop", description: "disables it and restarts the budget" },
			];
			const query = prefix.trim().toLowerCase();
			const matches = items.filter((item) => item.label.startsWith(query));
			return matches.length > 0 ? matches : items;
		},
		handler: async (args, ctx) => {
			await handleLimitCommand(args, ctx);
		},
	});
}
