#!/usr/bin/env bash
# ./install.sh [uninstall]   — links /easify into omp (~/.omp/agent).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
agent=${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}

case ${1:-install} in
install)
	chmod +x ezcode ezdraw
	mkdir -p "$agent/commands" "$agent/easify"
	ln -sfn "$PWD/easify.md" "$agent/commands/easify.md"
	ln -sfn "$PWD/ezcode" "$agent/easify/ezcode"
	ln -sfn "$PWD/ezdraw" "$agent/easify/ezdraw"
	echo "installed: /easify in omp (restart omp or /reload-plugins)"
	;;
uninstall)
	rm -f "$agent/commands/easify.md" "$agent/easify/ezcode" "$agent/easify/ezdraw"
	rmdir "$agent/easify" "$agent/commands" 2>/dev/null || true
	echo "uninstalled"
	;;
*)
	echo "usage: $0 [install|uninstall]" >&2
	exit 2
	;;
esac
