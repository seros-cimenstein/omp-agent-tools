#!/usr/bin/env bash
# Install seref_manager into omp: link extension/ into the user extensions directory, so edits
# in this repo take effect on the next omp start. Needs seref_loop next to this repo (the gate).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/extensions"
dest="$dest_dir/seref_manager"
gate="$here/../seref_loop/bin/seref-loop-gate"

[[ -x $gate ]] || echo "warning: no executable gate at $gate; set SEREF_LOOP_GATE before running omp" >&2
mkdir -p "$dest_dir"
if [[ -e $dest && ! -L $dest ]]; then
    echo "refusing to replace $dest (a real file, not our link); move it away first" >&2
    exit 1
fi
ln -sfn "$here/extension" "$dest"
echo "linked $dest -> $here/extension"
