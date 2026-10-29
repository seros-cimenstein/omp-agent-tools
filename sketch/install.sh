#!/usr/bin/env bash
# Install sketch into omp: link extension/ into the user extensions directory, so edits
# in this repo take effect on the next omp start (canvas.html on the next page reload).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/extensions"
dest="$dest_dir/sketch"

mkdir -p "$dest_dir"
if [[ -e $dest && ! -L $dest ]]; then
    echo "refusing to replace $dest (a real file, not our link); move it away first" >&2
    exit 1
fi
ln -sfn "$here/extension" "$dest"
echo "linked $dest -> $here/extension"
