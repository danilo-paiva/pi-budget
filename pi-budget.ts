/**
 * Session Budget - budget on three axes (cost, active time and output tokens), counted over the
 * whole session or from the start of each prompt.
 *
 * The extension is OFF by default. Limits are set with /budget and apply to the scope in use
 * (every prompt and automatic turn, until /budget stop or a new session):
 *
 *   /budget cost 0.50      maximum cost in US$
 *   /budget time 30        maximum active time in minutes (only counts while the agent runs)
 *   /budget tokens 200000  output tokens (accepts 200k)
 *   /budget prompt         scope: the usage restarts on every new prompt
 *   /budget session        scope: the usage accumulates over the session (default)
 *   /budget reset          keeps the limits, zeroes the usage
 *   /budget stop           disables it, clears the limits, the usage and the scope
 *   /budget                shows the current state
 *
 * Running /budget <axis> <value> again only changes that limit; the usage already made is kept
 * (raising it above the usage unblocks the session, lowering it below blocks it). Changing the
 * scope zeroes the usage, because the counter means something different in each scope.
 *
 * The form with arguments also works when the client sends the text as a plain message
 * (T3, for example, only dispatches a command when the message is exactly the command name):
 * the `input` hook recognizes "/budget ..." and runs it without reaching the model.
 *
 * The budget starts counting when the first limit is set. On every turn the model receives a
 * [session-budget] note with what is left. When a limit is exhausted, new prompts and tool calls
 * are blocked: crossed at the end of a response, the model gets one last turn for a summary;
 * crossed mid-stream (or by the time limit), the turn is aborted at once. In the per-prompt
 * scope a new prompt opens a fresh window. The state is saved in the session so /reload, resume
 * and fork keep it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "session-limit";

type Axis = "cost" | "time" | "tokens";

/** How the usage is counted: from the session start (default) or from the start of each prompt. */
export type Scope = "session" | "prompt";

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
	/** Estimated cost / output tokens of the message being streamed (not final yet). */
	pendingCost: number;
	pendingTokens: number;
	/** Reason for the block, once a limit is exhausted. */
	stopped?: string;
}

/** What survives /reload, resume and fork (stored as a custom session entry). */
interface PersistedState {
	limits: Limits;
	scope?: Scope;
	budget?: { startedAt: number; activeMs: number; cost: number; outputTokens: number; stopped?: string };
}

const ENTRY_TYPE = "session-limit";

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
	cost: "Use /budget cost 0.50",
	time: "Use /budget time 30",
	tokens: "Use /budget tokens 200000",
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

/** /budget prompt and /budget session, the two scopes. */
const SCOPE_ALIASES: Record<string, Scope> = {
	prompt: "prompt",
	"per-prompt": "prompt",
	session: "session",
	"per-session": "session",
};

export function parseScopeArgument(raw: string): Scope | undefined {
	return SCOPE_ALIASES[raw.trim().toLowerCase().replace(/[\s_]+/g, "-")];
}

/** Footer suffix: only the non-default scope is worth the pixels. */
function scopeTag(): string {
	return scope === "prompt" ? " · per prompt" : "";
}

function scopeNoun(): string {
	return scope === "prompt" ? "prompt" : "session";
}

function scopeSentence(): string {
	return scope === "prompt"
		? "per prompt (the usage restarts on every new prompt)"
		: "per session (the usage accumulates until /budget reset)";
}

const HELP = [
	"Usage: /budget <option> [value]",
	"",
	"  /budget cost 0.50      maximum cost (US$)",
	"  /budget time 30        maximum active time (minutes)",
	"  /budget tokens 200000  output tokens (accepts 200k)",
	"  /budget prompt         scope: limits apply to each prompt, usage restarts",
	"  /budget session        scope: limits apply to the whole session",
	"  /budget reset          keeps the limits, zeroes the usage",
	"  /budget stop           disables it, clears limits, usage and scope",
	"  /budget                shows the current state",
	"",
	"The budget is one per session and starts counting on the first /budget.",
	"Changing a limit keeps the usage; /budget reset zeroes it.",
	"Changing the scope zeroes the usage: the counter means something different in each scope.",
	"The extension starts disabled in every session.",
].join("\n");

const limits: Limits = {};
/** Counted over the whole session (default) or from the start of each prompt. */
let scope: Scope = "session";
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
		const used = (budget?.cost ?? 0) + (budget?.pendingCost ?? 0);
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
		const used = (budget?.outputTokens ?? 0) + (budget?.pendingTokens ?? 0);
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

function newBudget(): SessionBudget {
	return { startedAt: Date.now(), activeMs: 0, cost: 0, outputTokens: 0, pendingCost: 0, pendingTokens: 0 };
}

function ensureBudget(): SessionBudget {
	if (!budget) budget = newBudget();
	return budget;
}

/** Zero the accumulated usage and start counting now (/budget reset). */
function restartBudget(ctx?: ExtensionContext): void {
	clearTimer();
	budget = newBudget();
	syncClock(ctx);
	armTimer(ctx);
	updateStatus(ctx);
}

function resetAll(): void {
	clearTimer();
	budget = undefined;
	scope = "session";
	delete limits.cost;
	delete limits.time;
	delete limits.tokens;
}

// ---------------------------------------------------------------------------
// Persistence (survives /reload, resume and fork)
// ---------------------------------------------------------------------------

let persist: ((state: PersistedState) => void) | undefined;

function saveState(): void {
	if (!persist) return;
	const state: PersistedState = {
		limits: { ...limits },
		scope,
		budget: budget
			? {
					startedAt: budget.startedAt,
					activeMs: elapsedActiveMs(),
					cost: budget.cost,
					outputTokens: budget.outputTokens,
					stopped: budget.stopped,
				}
			: undefined,
	};
	try {
		persist(state);
	} catch {
		// Persistence is best-effort; the in-memory budget keeps working.
	}
}

/** Restores the last saved state on the current branch; no entry means a fresh, disabled session. */
function restoreState(ctx: ExtensionContext): void {
	resetAll();
	let saved: PersistedState | undefined;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) saved = entry.data as PersistedState;
		}
	} catch {
		// No session manager available: start disabled.
	}
	if (!saved) return;
	// The scope is remembered even without limits: it applies to the next limit set.
	if (saved.scope === "prompt") scope = "prompt";
	if (!saved.limits) return;

	for (const axis of ["cost", "time", "tokens"] as const) {
		const value = saved.limits[axis];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) limits[axis] = value;
	}
	if (!enabled()) return;

	budget = newBudget();
	if (saved.budget) {
		budget.startedAt = saved.budget.startedAt ?? budget.startedAt;
		budget.activeMs = saved.budget.activeMs ?? 0;
		budget.cost = saved.budget.cost ?? 0;
		budget.outputTokens = saved.budget.outputTokens ?? 0;
		budget.stopped = saved.budget.stopped;
	}
	syncClock(ctx);
	armTimer(ctx);
}

function updateStatus(ctx: ExtensionContext | undefined): void {
	if (!ctx) return;
	let text: string | undefined;

	if (enabled() && budget) {
		if (budget.stopped) {
			text = `budget STOPPED (${budget.stopped})${scopeTag()}`;
		} else {
			const current = view();
			const parts: string[] = [];
			if (current.cost) parts.push(`${money(current.cost.used)}/${money(current.cost.limit)}`);
			if (current.time) parts.push(`${minutes(current.time.usedMs)}/${minutes(current.time.limitMs)}`);
			if (current.tokens) {
				parts.push(`${compactTokens(current.tokens.used)}/${compactTokens(current.tokens.limit)} tok`);
			}
			text = parts.join(" · ") + scopeTag();
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
		const tail = abort
			? "Aborting the turn."
			: scope === "prompt"
				? "Tools are blocked until the next prompt."
				: "New prompts and tools will be blocked.";
		notice(ctx, `The ${scopeNoun()} budget is exhausted (${budget.stopped}). ${tail}`, "warning");
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
	const over = view().over;
	if (over.length > 0) {
		// Still blocked, possibly by a different axis than before.
		budget.stopped = over.map((axis) => AXIS_LABEL[axis]).join(" + ");
		updateStatus(ctx);
		return false;
	}

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
	const lines: string[] = [`[session-budget] remaining budget for this ${scopeNoun()}:`];

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
			`The ${scopeNoun()} budget is exhausted (${budget.stopped}). Do not call any tool. Reply with a short summary of what is done and what is unfinished, and stop.`,
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

function costOfUsage(usage: UsageLike, ctx: ExtensionContext, source?: { provider?: string; model?: string }): number {
	const reported = usage.cost?.total;
	if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;

	// Rates of the model that produced the message, not the one selected right now.
	let producer: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
	if (source?.provider && source.model) {
		try {
			producer = ctx.modelRegistry.find(source.provider, source.model);
		} catch {
			producer = undefined;
		}
	}
	const rates = producer?.cost ?? ctx.model?.cost;
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
// /budget command
// ---------------------------------------------------------------------------

export function parseAmountForAxis(axis: Axis, raw: string): number | undefined {
	let text = raw.trim().toLowerCase();

	if (axis === "time") text = text.replace(/\s*(min|mins|minute|minutes)$/, "");
	if (axis === "tokens") text = text.replace(/\s*(tokens?|tok|tk)$/, "");
	if (axis === "cost") text = text.replace(/^(us\$|\$)/, "").replace(/\s*(usd|dollars?)$/, "");

	// Tokens are whole numbers, so "200,000" / "200.000" / "200_000" are thousands separators.
	// Everything else treats a comma as the decimal separator ("0,50", "1,5k").
	if (axis === "tokens" && /^\d{1,3}(?:[.,_]\d{3})+$/.test(text)) {
		text = text.replace(/[.,_]/g, "");
	} else {
		text = text.replace(",", ".");
	}

	const match = /^([0-9]+(?:\.[0-9]+)?)([km])?$/.exec(text);
	if (!match) return undefined;

	const base = Number(match[1]);
	const multiplier = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : 1;
	const value = base * multiplier;
	if (!Number.isFinite(value) || value <= 0) return undefined;

	return axis === "tokens" ? Math.max(1, Math.round(value)) : value;
}

function statusReport(): string {
	const lines: string[] = [enabled() ? "Budget: ACTIVE" : "Budget: DISABLED"];
	lines.push(`Scope: ${scopeSentence()}.`);

	if (!enabled()) {
		lines.push("");
		lines.push("No limits set.");
		lines.push("");
		lines.push("  /budget cost 0.50");
		lines.push("  /budget time 30");
		lines.push("  /budget tokens 200000");
		lines.push("  /budget prompt     (or /budget session)");
		lines.push("  /budget stop");
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
	const window = scope === "prompt" ? "this prompt" : "this session";
	if (!budget) {
		lines.push("The budget starts counting on the first /budget.");
	} else {
		const started = new Date(budget.startedAt).toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
		});
		if (budget.stopped) {
			lines.push(`Counting ${window} since ${started}. BLOCKED by ${budget.stopped}.`);
			lines.push(scope === "prompt" ? "The block ends with the next prompt." : "Raise a limit to unblock.");
		} else {
			lines.push(`Counting ${window} since ${started}.`);
		}
	}
	lines.push("Use /budget reset to zero the usage, or /budget stop to disable it.");
	if (scope === "session") lines.push("Use /budget prompt to restart the usage on every new prompt.");
	return lines.join("\n");
}

/**
 * Recognizes "/budget ..." sent as a plain message. Clients such as T3 only dispatch a command
 * when the text is exactly the name, so the form with arguments arrives as a prompt.
 */
function matchBudgetCommand(text: string): string | undefined {
	const match = /^\/budget(?:\s+([\s\S]*))?$/i.exec(text.trim());
	return match ? (match[1] ?? "").trim() : undefined;
}

/** Sets the scope. The counter means something different in each scope, so a change starts over. */
function applyScope(next: Scope, ctx: ExtensionContext): void {
	const changed = scope !== next;
	scope = next;
	if (changed && enabled()) restartBudget(ctx);
	else updateStatus(ctx);

	const lines = [`Scope: ${scopeSentence()}.`];
	if (changed && enabled()) lines.push("The usage was restarted at zero.");
	if (enabled()) lines.push(`Active: ${activeSummary()}.`);
	else lines.push("No limits set yet, e.g. /budget cost 0.50.");
	notice(ctx, lines.join("\n"), "info");
}

async function handleBudgetCommand(args: string, ctx: ExtensionContext): Promise<void> {
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
		notice(ctx, "Budget disabled. Limits, usage and scope were cleared.", "info");
		return;
	}

	if (axisRaw === "reset" || axisRaw === "restart") {
		if (!enabled()) {
			notice(ctx, "No active limits. Set one first, e.g. /budget cost 0.50", "info");
			return;
		}
		restartBudget(ctx);
		notice(ctx, `Budget restarted (usage reset to zero).\nScope: ${scopeSentence()}.\nActive: ${activeSummary()}.`, "info");
		return;
	}

	if (axisRaw === "help" || axisRaw === "?" || axisRaw === "--help") {
		notice(ctx, HELP, "info");
		return;
	}

	const scopeWord = parseScopeArgument(axisRaw);
	if (scopeWord) {
		if (valueRaw) {
			notice(
				ctx,
				`"${axisRaw}" selects the scope and takes no value.\nUse /budget prompt or /budget session, or /budget cost 0.50 to set a limit.`,
				"error",
			);
			return;
		}
		applyScope(scopeWord, ctx);
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
				: `${AXIS_LABEL[axis]} limit: ${formatLimit(axis, current)} per ${scopeNoun()}. ${AXIS_HINT[axis]}`,
			"info",
		);
		return;
	}

	if (/^(off|none|clear|0+(?:[.,]0+)?)$/i.test(valueRaw)) {
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
		const suffix = released ? "\nBudget unblocked." : "";
		notice(ctx, `${AXIS_LABEL[axis]} limit removed. Active: ${activeSummary()}.${suffix}`, "info");
		return;
	}

	const amount = parseAmountForAxis(axis, valueRaw);
	if (amount === undefined) {
		notice(ctx, `Invalid value for ${AXIS_LABEL[axis]}: "${valueRaw}".\n${AXIS_HINT[axis]}`, "error");
		return;
	}

	// Changing a limit never touches the usage already made: use /budget reset for that.
	const alreadyEnabled = enabled();
	limits[axis] = amount;

	ensureBudget();
	syncClock(ctx);
	armTimer(ctx); // the time limit may have changed
	const released = releaseIfRecovered(ctx);
	// A limit lowered below the usage already made blocks the session right away.
	const blocked = stopIfNeeded(ctx, false);
	updateStatus(ctx);

	const running = budget ? budget.runningSince !== undefined : false;
	const scopeNote = alreadyEnabled
		? "Usage kept (use /budget reset to zero it)."
		: running
			? "Applied to the running session."
			: "Effective from now.";
	const stateNote = released
		? "\nBudget unblocked."
		: blocked
			? `\nStill blocked (${budget?.stopped}): the usage is already over the limit.`
			: "";
	notice(
		ctx,
		`${AXIS_LABEL[axis]} limit set: ${formatLimit(axis, amount)} per ${scopeNoun()}.\nActive: ${activeSummary()}. ${scopeNote}${stateNote}`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sessionLimit(pi: ExtensionAPI) {
	persist = (state) => pi.appendEntry(ENTRY_TYPE, state);

	// A brand-new session starts with no limits (nothing saved). Reload, resume and fork restore
	// the state saved on the current branch, so /reload does not silently switch the budget off.
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		warnedMissingCost = false;
		restoreState(ctx);
		updateStatus(ctx);
	});

	// Per-prompt scope: every prompt the user starts opens a fresh window. Runs that continue the
	// same prompt (a retry, a compaction, a queued message) do not fire this hook again.
	pi.on("before_agent_start", async (event, ctx) => {
		lastCtx = ctx;
		if (scope !== "prompt" || !enabled() || event.messageType !== "user") return;
		restartBudget(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		saveState();
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
		if (enabled()) saveState();
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

	// While a response streams, watch an estimate of its cost/tokens so a long answer cannot
	// run far past the limit before message_end. Estimates are dropped at message_end.
	pi.on("message_update", async (event, ctx) => {
		lastCtx = ctx;
		if (!budget || !enabled() || budget.stopped) return;
		if (limits.cost === undefined && limits.tokens === undefined) return;

		const partial = event.message as unknown as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: UsageLike;
			content?: Array<{ type?: string; text?: string; thinking?: string; arguments?: unknown }>;
		};
		if (partial.role !== "assistant") return;

		let chars = 0;
		for (const block of partial.content ?? []) {
			if (block.type === "text") chars += block.text?.length ?? 0;
			else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
			else if (block.type === "toolCall") chars += JSON.stringify(block.arguments ?? {}).length;
		}
		// ~4 characters per token: rough, so it is only a floor next to what the provider reports.
		const output = Math.max(partial.usage?.output ?? 0, Math.ceil(chars / 4));
		budget.pendingTokens = output;
		budget.pendingCost = costOfUsage({ ...partial.usage, output }, ctx, partial);

		stopIfNeeded(ctx, true);
	});

	// Accounts the cost and output tokens of every finalized message.
	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!budget || !enabled()) return;

		const message = event.message as unknown as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: UsageLike;
			content?: Array<{ type?: string }>;
		};
		const pendingTokens = budget.pendingTokens;
		budget.pendingCost = 0;
		budget.pendingTokens = 0;

		let usage = message.usage;
		if (!usage) return;
		if (message.role !== "assistant" && message.role !== "toolResult") return;
		// An aborted stream may report no usage; fall back to what was streamed.
		if (message.role === "assistant" && (usage.output ?? 0) === 0 && pendingTokens > 0) {
			usage = { ...usage, output: pendingTokens };
		}

		const wasStopped = budget.stopped !== undefined;
		const cost = costOfUsage(usage, ctx, message);
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

		// First time the limit is crossed at the end of a message: block tools but let the model
		// write one last summary turn. If it still asks for tools after that, abort.
		stopIfNeeded(ctx, wasStopped && wantsMoreTools);
	});

	// With the budget exhausted no tool runs anymore.
	pi.on("tool_call", async (_event, ctx) => {
		lastCtx = ctx;
		if (!budget || !enabled()) return;

		if (!budget.stopped) stopIfNeeded(ctx, false);
		if (!budget.stopped) return;

		// No `terminate`: that would end the turn before the model reads the reason and writes
		// its final summary.
		return {
			block: true,
			reason: `[session-budget] Session budget exhausted (${budget.stopped}). Do not call tools. Reply with a short summary of what is done and what remains, then stop.`,
		};
	});

	// Two roles:
	// 1) accept "/budget ..." typed as a plain message - clients such as T3 only dispatch a
	//    command when the message is exactly the name, so "/budget time 1" would become a prompt;
	// 2) block prompts once the session budget is exhausted.
	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (event.source === "extension") return { action: "continue" as const };

		const commandArgs = matchBudgetCommand(event.text);
		if (commandArgs !== undefined) {
			await handleBudgetCommand(commandArgs, ctx);
			saveState();
			return { action: "handled" as const };
		}

		if (!budget || !enabled()) return { action: "continue" as const };

		// Per-prompt scope: a prompt typed while idle opens a new window in before_agent_start, so it
		// is never blocked here. Steering and follow-up messages stay inside the current window.
		if (scope === "prompt" && event.streamingBehavior === undefined) return { action: "continue" as const };

		if (!budget.stopped) stopIfNeeded(ctx, false);
		if (!budget.stopped) return { action: "continue" as const };

		notice(
			ctx,
			`${scope === "prompt" ? "Prompt" : "Session"} budget exhausted (${budget.stopped}). Raise a limit with /budget or disable it with /budget stop.`,
			"warning",
		);
		return { action: "handled" as const };
	});

	pi.registerCommand("budget", {
		description: "Limit cost, active time and output tokens, per session or per prompt (off by default)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "cost ", label: "cost", description: "maximum cost in US$" },
				{ value: "time ", label: "time", description: "maximum active time in minutes" },
				{ value: "tokens ", label: "tokens", description: "output tokens" },
				{ value: "prompt", label: "prompt", description: "scope: usage restarts on every new prompt" },
				{ value: "session", label: "session", description: "scope: usage accumulates over the session" },
				{ value: "status", label: "status", description: "shows the current state" },
				{ value: "reset", label: "reset", description: "keeps the limits, zeroes the usage" },
				{ value: "stop", label: "stop", description: "disables it, clears usage and scope" },
			];
			const query = prefix.trim().toLowerCase();
			const matches = items.filter((item) => item.label.startsWith(query));
			return matches.length > 0 ? matches : items;
		},
		handler: async (args, ctx) => {
			await handleBudgetCommand(args, ctx);
			saveState();
		},
	});
}
