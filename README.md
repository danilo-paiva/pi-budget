# pi-limit

A [pi](https://github.com/earendil-works/pi) extension that puts a **session-wide budget** on the
model along three axes: **cost**, **active time** and **output tokens**.

The extension is **disabled by default** and only turns on through the `/limit` command.

## Install

This repo is a [pi package](https://pi.dev/packages), so install it with `pi install`:

```sh
pi install git:github.com/danilo-paiva/pi-limit
```

Then start pi, or run `/reload` in a running session. Useful commands:

```sh
pi list                                          # installed packages
pi update git:github.com/danilo-paiva/pi-limit   # update to the latest commit
pi remove git:github.com/danilo-paiva/pi-limit   # uninstall
pi install -l git:github.com/danilo-paiva/pi-limit   # project-only (.pi/settings.json)
```

Pin a version with a tag or commit: `pi install git:github.com/danilo-paiva/pi-limit@<ref>`.

To try it for a single run without installing: `pi -e git:github.com/danilo-paiva/pi-limit`.

### Manual install

Copy `pi-limit.ts` into `~/.pi/agent/extensions/` (picked up automatically; `/reload` reloads it)
or load a local copy with `pi --extension ./pi-limit.ts`. Do not combine this with `pi install`:
the extension would be loaded twice.

## Usage

```
/limit cost 0.50      # maximum session cost in US$
/limit time 30        # maximum session active time, in minutes
/limit tokens 200000  # session output tokens (20k / 200k suffixes work)
/limit                # current state: limits, used, remaining
/limit reset          # keep the limits, zero the usage
/limit stop           # disable, clear the limits and the usage
/limit help           # help
```

- The budget is **one per session** and starts counting on the first `/limit`.
- Running `/limit <axis> <value>` again only **changes that limit**; the usage already made is
  kept, so the counters stay honest. Use `/limit reset` to zero the usage.
- Tokens accept thousands separators (`200,000`, `200.000`, `200_000`) and suffixes (`200k`).
  For cost and time, a comma is a decimal separator (`0,50`).
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
- When a limit is **exhausted** the status line shows `session limit: STOPPED (...)`, new prompts
  are rejected and tool calls are blocked. How the running turn ends depends on where the limit
  was crossed:
  - **at the end of a response** (cost/tokens): the model gets one last turn to write a short
    summary of what is done and what remains; if it still asks for tools, the turn is aborted;
  - **while a response is streaming** (cost/tokens, using a ~4 chars/token estimate when the
    provider reports no partial usage) or when the **time** limit hits: the turn is aborted
    immediately, with no summary.
- The state (limits and usage) is saved in the session, so `/reload`, resume and fork keep it.
  A brand-new session starts disabled.
- Cost uses the rates of the model that produced each message when the provider reports no cost.
- Raising a limit above the usage already made (or `/limit reset`) unblocks the session; lowering
  a limit below the usage already made blocks it right away.

## Notes

- Tests: `node --test pi-limit.test.ts` (Node 22.18+).
- Requires pi's extension API (`ExtensionAPI`, `ExtensionContext`); TypeScript is loaded directly,
  no build step.
- The command also works when a client sends `/limit ...` as a plain message instead of dispatching
  a command (some clients only dispatch commands without arguments). An `input` hook recognizes the
  text and runs it without reaching the model.
- The UI is in English; the model-facing note is in English too.
