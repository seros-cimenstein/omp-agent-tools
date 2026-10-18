# seref_manager

An AI manager for [seref_loop](../seref_loop/README.md) ledgers. omp's `/loop` only resends the same
prompt until a shell check passes, and an `ask` dialog during an overnight run waits forever.
`/seref_manager run` drives the loop itself: after every iteration a manager model reviews what the
worker actually did and decides how the next iteration starts, and it answers `ask` dialogs that
nobody answers.

It does not use omp's `judge` role. The manager is an ordinary chat model call, by default the
session's model, with its own prompts (`extension/prompts/`).

## How it works

```mermaid
flowchart TD
  R["/seref_manager run LOOP_X.md"] --> W["worker iteration<br/>(prompt + manager notes)"]
  W -->|"yields"| G{"seref-loop-gate"}
  G -->|"0"| D["done: only the gate ends the loop as done"]
  G -->|"2"| E["stops with the gate's error"]
  G -->|"1"| S{"limit or no progress?"}
  S -->|"yes"| X["stops, says why"]
  S -->|"no"| M["manager reviews the iteration"]
  M -->|"stuck / item reopened 3x"| X
  M -->|"reopen, unblock, answers, guidance"| L["ledger edits + notes"]
  L -->|"compact if chosen"| W
```

After each worker yield:

1. **Gate.** `seref-loop-gate LOOP_X.md`: exit 0 ends the loop as done, 2 ends it with the error.
2. **Hard stops.** The iteration limit (`--max`, default twice the item count, at least 5), or 2
   iterations in a row that change no item state and no STATUS line.
3. **Review.** The manager model gets the ledger, the items that changed state, the gate summary,
   a digest of the iteration (worker text, tool calls with arguments, head and tail of every tool
   result), and its own last 8 decisions. It replies with JSON:
   - `reopen`: `[x]` items ticked this iteration whose evidence the transcript doesn't back. The
     line goes back to `- [ ]`, losing its DONE evidence, with `— MANAGER(itN): reopened: <reason>`.
   - `unblock`: `[!]` items whose reason is difficulty or size → `- [ ] … — MANAGER(itN): blocker rejected: …`.
   - `answers`: questions the worker left in its final text, answered or explicitly deferred.
   - `guidance`: instructions for the next iteration.
   - `context`: `compact` runs omp's compaction before the next prompt.
   - `verdict`: `stuck` stops the loop. There is no `done`; the manager cannot finish the loop.
4. **Next iteration.** The worker prompt (`extension/prompts/worker.md`) plus the manager's notes.

If one item is reopened 3 times, the loop stops so you can look at it. If the manager call fails
twice for one iteration, that iteration continues without guidance; 3 such iterations in a row
pause the loop.

### `ask` while the loop runs

On the first `run` in a session, the extension takes over the built-in `ask` tool, keeping its
schema and description:

- No loop, or the loop is paused: it runs the native `ask` unchanged.
- Loop running: the native dialog opens and you get `--grace` seconds (default 120) to answer.
  After that the dialog closes and the manager answers from the ledger, the current iteration's
  transcript, and the project's rules. It defers instead of guessing when the choice is
  destructive, touches credentials, money or live data, breaks a ledger rule, or has no
  conservative default. A deferred question tells the worker to mark the item
  `BLOCKED: awaiting user: <question>` and move on.
- `/seref_manager away` (or `--away`) skips the dialog: the manager answers at once.

Every decision and answer is appended to `LOOP_X.manager.md` next to the ledger.

## Commands

| Command | What |
|---|---|
| `/seref_manager run <LOOP_X.md> [--max N] [--grace S] [--model SPEC[:effort]] [--away]` | start; the gate must exit 1 |
| `/seref_manager pause` / `resume` | pause after the current turn / continue (re-reviews the last iteration) |
| `/seref_manager stop` | end the loop |
| `/seref_manager away [on\|off]` | toggle answering `ask` without the grace period |
| `/seref_manager status` | iteration, item counts, recent manager decisions, log path |

Esc during a worker turn pauses the loop. `--model` takes anything `--model` takes in omp
(`provider/id`, a bare id, `@role`), with an optional `:effort` suffix (default `medium`).

## Install / test

```bash
./install.sh     # links extension/ to ~/.omp/agent/extensions/seref_manager; restart omp
bun test         # ledger edits (against the real gate), reply parsing, transcript digest
```

The gate is found at `../seref_loop/bin/seref-loop-gate`, relative to this repo's real path;
set `SEREF_LOOP_GATE` to use another one.

## Limits

- Loop state lives in memory: restarting omp or switching sessions ends the loop. The ledger
  holds all progress, so `/seref_manager run` again picks up where it stopped.
- There is no `reset` (fresh session per iteration); extensions cannot start a new session from
  the loop's event handlers. `compact` is the context control.
- The manager reviews only items that changed state in the iteration it sees. An unproven tick
  from an earlier run is not re-checked.
