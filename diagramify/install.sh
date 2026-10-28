#!/usr/bin/env bash
# ./install.sh [uninstall]   — links /diagramify and its SVG templates into omp (~/.omp/agent).
# Block codes come from /easify's ezcode: install ../easify first.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
agent=${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}

case ${1:-install} in
install)
	mkdir -p "$agent/commands" "$agent/diagrams"
	ln -sfn "$PWD/diagramify.md" "$agent/commands/diagramify.md"
	ln -sfn "$PWD/card.svg" "$agent/diagrams/card.svg"
	ln -sfn "$PWD/layers.svg" "$agent/diagrams/layers.svg"
	[ -x "$agent/easify/ezcode" ] || echo "warning: $agent/easify/ezcode missing; run ../easify/install.sh" >&2
	echo "installed: /diagramify in omp (restart omp or /reload-plugins)"
	;;
uninstall)
	rm -f "$agent/commands/diagramify.md" "$agent/diagrams/card.svg" "$agent/diagrams/layers.svg"
	rmdir "$agent/diagrams" "$agent/commands" 2>/dev/null || true
	echo "uninstalled"
	;;
*)
	echo "usage: $0 [install|uninstall]" >&2
	exit 2
	;;
esac
