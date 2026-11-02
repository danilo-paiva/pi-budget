# pi-limit

A [pi](https://github.com/earendil-works/pi) extension that puts a **session-wide budget** on the
model along three axes: **cost**, **active time** and **output tokens**.

The extension is **disabled by default** and only turns on through the `/limit` command.

## Install

Copy `pi-limit.ts` into your pi extensions directory and start (or reload) pi:

```
~/.pi/agent/extensions/pi-limit.ts
```

Or load it for a single run: `pi --extension ./pi-limit.ts`

Personal extensions are picked up automatically; `/reload` reloads them in a running session.

## Usage

```
/limit cost 0.50      # maximum session cost in US$
/limit time 30        # maximum session active time, in minutes
/limit tokens 200000  # session output tokens (20k / 200k suffixes work)
/limit                # current state: limits, used, remaining
/limit stop           # disable, clear the limits and restart the budget
/limit help           # help
```

- The budget is **one per session** and starts counting on the first `/limit`.
- Running `/limit <axis> <value>` again **restarts** the budget (usage reset to zero), so the
  same command doubles as "start this limit again".
- A new session starts disabled with no limits.
- Removing a single axis: `/limit time off`.

## How it behaves

- **Cost** — the session's accumulated `usage.cost` (reported by the provider, or estimated from
  the model rates when the provider reports zero).
- **Active time** — wall clock while the agent is working (`agent_start` -> `agent_settled`).
  It includes API latency, time to first token, streaming, tool execution and retries; idle time
  between prompts does not count.
- **Output tokens** — accumulated `usage.output` across the session, including nested model work
  reported by tools.
- On **every turn** the model receives a `[session-budget]` note at the end of the request with
  what is left of each limit. The note is request-local: it is not persisted in the transcript.
- When a limit is **exhausted**: new tool calls are blocked, new prompts are rejected, the running
  turn is aborted, and the status line shows `session limit: STOPPED (...)`.
- Raising a limit above the usage already made (or restarting with `/limit`) unblocks the session.

## Notes

- Requires pi's extension API (`ExtensionAPI`, `ExtensionContext`); TypeScript is loaded directly,
  no build step.
- The command also works when a client sends `/limit ...` as a plain message instead of dispatching
  a command (some clients only dispatch commands without arguments). An `input` hook recognizes the
  text and runs it without reaching the model.
- The UI is in English; the model-facing note is in English too.
