---
description: Turn findings or a goal into a gated /loop ledger that runs until every item is done
argument-hint: "[goal | findings file | empty = what we just discussed]"
---

Set up a seref_loop: a checklist ledger plus a `/loop` command line that keeps running until every
item is really finished. This turn only sets it up; do not start fixing items.

Goal: `$ARGUMENTS`
- Empty: use what this conversation just produced (an audit, review findings, a plan).
- A path: the findings/plan in that file.
- Otherwise: the goal as written.
- Nothing usable: ask once what the loop should accomplish, then stop.

Toolkit: `~/projects/seref_omp_tools/seref_loop/` (`templates/LEDGER.md`, `bin/seref-loop-gate`;
`README.md` explains the method).

## 1. Look into it yourself
Don't copy the source list. Verify every item against the code and, when reachable, the live
data/hosts. Record the file:line, the measured numbers, and how sure you are. Downgrade claims
that don't hold and say why (e.g. "only leaks in replay"). Add the problems you find on your own.
For a broad target, fan out read-only scouts per area, then check their high-severity claims
yourself. Learn how the project tests and deploys, which hosts it runs on, when deploys would be
unsafe (live trading hours, scheduled jobs), and whether `git status` shows uncommitted user work.

## 2. Write the ledger
Copy `templates/LEDGER.md` to the target repo root as `LOOP_<SHORT_SLUG>.md`. If that file
already exists, don't overwrite it: reuse it if it's for the same goal, or pick a new name. Fill
in every double-brace placeholder; none may remain.
- **Protocol**: the real test commands per package; the smoke hosts and commands; deploy steps;
  forbidden windows; backups; the commit policy (no commits when the tree has the user's
  uncommitted changes); paths not to touch.
- **Items**, one line each: `- [ ] <ID> <problem> (<file:line>; <evidence>). <fix direction>. Acceptance: <observable check>.`
  - Atomic: each can be finished and verified in one iteration. Split anything bigger.
  - Ordered by deadline, then dependency, then impact. Sections A, B, … run in order; name
    cross-item dependencies inside the item ("do B4 first").
  - Every finding the user asked to fix gets an item; never drop one silently.
- **Decisions**: where a fix has materially different options, pick the conservative default and
  write it into the item. List every such choice in your reply so the user can veto it
  (by marking that item `- [!] … — BLOCKED: user veto`) before starting.

## 3. Prove the gate
From the repo root, run `~/projects/seref_omp_tools/seref_loop/bin/seref-loop-gate LOOP_<SLUG>.md`.
It must exit 1 (open). Exit 2 means the ledger is malformed: fix it and run it again.

## 4. Reply
Write it in this order:
1. One line: ledger path, item count, number of sections, earliest deadline.
2. The command to paste, as a fenced block. Use a limit of about twice the item count; ITEMS
   below is that number.
   ```
   /loop <ITEMS> --until '~/projects/seref_omp_tools/seref_loop/bin/seref-loop-gate LOOP_<SLUG>.md' Read LOOP_<SLUG>.md and follow its Protocol exactly: take the first "- [ ]" item, re-check that the finding still holds, fix it at the root, verify with tests plus a real smoke run, deploy only within the allowed windows, then mark it "- [x] ... — DONE: <evidence>". When no "- [ ]" is left, run every suite and the final check, set "STATUS: DONE", add the summary, and confirm the gate exits 0.
   ```
3. How the stop works, briefly:
   - The loop ends only when the gate exits 0.
   - A DONE claim with open or unproven items is rejected and the loop keeps going.
   - A missing or broken ledger stops the loop with an error.
   - Esc pauses the loop; `/loop` again turns it off.
4. The default choices you made (from step 2) and any risks.
5. For more than ~15 items: suggest setting `loop.mode` to `compact` or `reset`. The ledger is the
   memory, so fresh context each iteration is safe.
