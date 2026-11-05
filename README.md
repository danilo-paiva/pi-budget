# pi-budget

An extension for [pi](https://github.com/earendil-works/pi) that makes agents budget-aware.
It caps **cost**, **active time** and **output tokens** per session or per prompt, and stops the
session when the budget runs out. Off until you run `/budget`.

Shown in pi's footer (status bar), as usage / limit per axis:

```
$0.1200/$0.5000 · 3.0 min/30.0 min · 12.5k/200.0k tok
```

In the per-prompt scope the footer ends with `· per prompt`.

## Install

```sh
pi install git:github.com/danilo-paiva/pi-budget
```

Then start pi or run `/reload`. Update and remove with `pi update` / `pi remove` on the same source.

## Usage

```
/budget cost 0.50       # max cost, US$
/budget time 30         # max active time, minutes
/budget tokens 200k     # max output tokens (200000, 200,000 and 200.000 also work)
/budget                 # show scope, limits, usage and what is left
/budget <axis> off      # remove one limit
/budget reset           # keep the limits, zero the usage
/budget stop            # disable everything (limits, usage and scope)
```

### Scope

```
/budget prompt          # the usage restarts on every new prompt
/budget session         # the usage accumulates over the session (default)
```

In the per-prompt scope every prompt gets the full limit: the counters go back to zero when a new
prompt starts, and a blocked session unblocks itself. Steering and follow-up messages sent while the
agent is still answering belong to the current prompt and do not restart it.

Changing the scope restarts the usage, because the counter means something different in each scope.

- One budget per session, counting from the first `/budget`. Changing a limit keeps the usage.
- Limits, usage and scope are saved in the session (`/reload`, resume and fork keep them). A new
  session starts with no limits.
- The model gets a `[session-budget]` note on every request with what is left.

## When a limit is reached

Tool calls are blocked and the status line shows `STOPPED`. If a limit is crossed at the end of a
response, the model gets one last turn to summarize what is left. Mid-stream (cost, tokens) or on the
time limit, the turn is aborted at once. A new prompt is blocked in the session scope; in the
per-prompt scope it always opens a fresh window.

Limits are checked per message, so they are soft. If a model reports no cost and has no known rates,
the cost limit cannot count it.

## Development

```sh
npm test    # node --test pi-budget.test.ts (Node 22.18+)
```
