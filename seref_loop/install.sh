#!/usr/bin/env bash
# Install /seref_loop into omp: link commands/seref_loop.md into the user commands directory,
# so edits in this repo take effect on the next omp start (or /reload-plugins), and link this
# folder to ~/.omp/agent/seref_loop, the toolkit path the command and the ledger template name.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
dest_dir="$agent_dir/commands"
dest="$dest_dir/seref_loop.md"
toolkit="$agent_dir/seref_loop"

chmod +x "$here/bin/seref-loop-gate" "$here/tests/test_gate.sh"
mkdir -p "$dest_dir"
for link in "$dest" "$toolkit"; do
    if [[ -e $link && ! -L $link ]]; then
        echo "refusing to replace $link (a real file, not our link); move it away first" >&2
        exit 1
    fi
done
ln -sfn "$here/commands/seref_loop.md" "$dest"
echo "linked $dest -> $here/commands/seref_loop.md"
ln -sfn "$here" "$toolkit"
echo "linked $toolkit -> $here"
