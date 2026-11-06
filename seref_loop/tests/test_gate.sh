#!/usr/bin/env bash
# Contract test for bin/seref-loop-gate: the exit status omp's /loop acts on.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
gate="$here/bin/seref-loop-gate"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

check() {  # check <expected exit> <name> <ledger text, or "-" for no file>
    local want=$1 name=$2 text=$3 got
    rm -f "$tmp/L.md"
    [[ $text == - ]] || printf '%s\n' "$text" >"$tmp/L.md"
    (cd "$tmp" && "$gate" L.md 2>/dev/null)
    got=$?
    if [[ $got == "$want" ]]; then echo "ok   $name"; else echo "FAIL $name: want $want, got $got"; fails=$((fails + 1)); fi
}

open='STATUS: OPEN

- [x] A1 fixed — DONE: a.py; pytest ok
- [ ] A2 still open'
done_ok='STATUS: DONE

- [x] A1 fixed — DONE: a.py; pytest ok
- [x] A2 was wrong — INVALID: already guarded at b.py:12
- [!] A3 needs keys — BLOCKED: no access to host x, ssh refused'

check 1 "open items keep looping" "$open"
check 1 "DONE claim with an open item is rejected" "${open/STATUS: OPEN/STATUS: DONE}"
check 1 "all ticked but STATUS still OPEN" "${done_ok/STATUS: DONE/STATUS: OPEN}"
check 0 "done with evidence, invalid and blocked items" "$done_ok"
check 1 "[x] without DONE:/INVALID: evidence" "${done_ok/ — DONE: a.py; pytest ok/}"
check 1 "[!] without BLOCKED: reason" "${done_ok/ — BLOCKED: no access to host x, ssh refused/}"
check 2 "missing ledger" -
check 2 "no STATUS line" "${done_ok/STATUS: DONE/}"
check 2 "unknown STATUS" "${done_ok/STATUS: DONE/STATUS: FINISHED}"
check 2 "no items" "STATUS: DONE"
check 2 "unfilled template placeholder" "$(cat "$here/templates/LEDGER.md")"
check 0 "lowercase braces in content are fine" "${done_ok}
Note: jinja {{ value }} in a snippet."

(( fails == 0 )) && echo "all gate checks passed" || { echo "$fails failed"; exit 1; }
