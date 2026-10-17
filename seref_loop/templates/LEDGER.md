# Loop ledger: {{TITLE}} ({{DATE}})

STATUS: OPEN

Source: {{SOURCE — the findings/plan these items come from, with paths}}. This file is the loop's
memory and its stop switch: `/loop --until '~/projects/seref_omp_tools/seref_loop/bin/seref-loop-gate {{LEDGER_FILE}}'`
stops only when the line above reads `STATUS: DONE`, no `- [ ]` is left, every `- [x]` carries
`DONE:`/`INVALID:` evidence and every `- [!]` a `BLOCKED:` reason.

## Protocol (every iteration)

1. Read this file. Take the first `- [ ]` item in order (earlier sections first; respect
   deadlines and the dependencies named in items).
2. Before editing, read the code the item names and re-check that the finding still holds. Already
   fixed or wrong: mark `- [x] … — INVALID: <evidence>`.
3. Fix it at the root with the project's existing patterns; migrate every caller; update the docs
   that describe the changed behavior in the same step.
4. Verify: {{TEST_COMMANDS — exact commands per package}}. Add a regression test when the bug can be
   shown in one. Smoke the changed path where it really runs: {{HOSTS / RUN COMMANDS}}.
5. Deploy: {{DEPLOY STEPS, or "none"}}. {{FORBIDDEN WINDOWS, e.g. never during market hours}}.
   Back up any DB before a schema change or backfill.
6. Edit this file: `- [ ]` -> `- [x]` and append ` — DONE: <files>; <test/smoke evidence>`.
   One item per iteration is fine; finish an item completely or leave it `- [ ]`.
7. Blocked only for a user decision (ask with the `ask` tool first) or an unreachable host/credential:
   `- [!] … — BLOCKED: <exact missing thing, what was tried>`. Difficulty, size or scope pressure
   is not a blocker.
8. When no `- [ ]` is left: run every test suite and {{FINAL CHECK}}, replace the STATUS line with
   `STATUS: DONE`, append a summary (done / invalid / blocked) at the bottom, then run the gate
   command above. It must exit 0; if it does not, fix what its message names before yielding.

Rules:
- {{COMMIT POLICY — e.g. "Do not git commit; the tree has the user's uncommitted changes."}}
- {{PATHS NOT TO TOUCH}}
- No destructive commands on live data without a backup.

## A. {{SECTION — highest priority / deadline first}}

- [ ] A1 {{PROBLEM in one sentence}} ({{FILE:LINE}}; {{EVIDENCE: measured numbers, query result}}). {{FIX DIRECTION / chosen default}}. Acceptance: {{OBSERVABLE CHECK}}.

## B. {{SECTION}}

- [ ] B1 {{ITEM, same shape as A1}}
