#!/usr/bin/env bash
# Install /seref_loop into omp: link commands/seref_loop.md into the user commands directory,
# so edits in this repo take effect on the next omp start (or /reload-plugins).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/commands"
dest="$dest_dir/seref_loop.md"

chmod +x "$here/bin/seref-loop-gate" "$here/tests/test_gate.sh"
mkdir -p "$dest_dir"
if [[ -e $dest && ! -L $dest ]]; then
    echo "refusing to replace $dest (a real file, not our link); move it away first" >&2
    exit 1
fi
ln -sfn "$here/commands/seref_loop.md" "$dest"
echo "linked $dest -> $here/commands/seref_loop.md"
