# omp-agent-tools

Extensions, slash commands and helpers I built for [omp](https://github.com/can1357/oh-my-pi)
(oh-my-pi), a terminal AI coding agent. Most of them plug into omp's extension and command
directories under `~/.omp/agent`; notipill also works with other agent CLIs (Claude Code, Codex,
Copilot, Gemini). Each folder is independent, has its own README and its own `install.sh` where
one is needed.

| Tool | Kind | What it does |
|---|---|---|
| [seref_loop](seref_loop/) | slash command + shell gate | `/seref_loop` turns a list of findings into a checked ledger file, and `seref-loop-gate` lets a loop stop only when every item is done with evidence or blocked with a reason. |
| [seref_manager](seref_manager/) | omp extension (TypeScript) | `/seref_manager run` drives a seref_loop ledger: after each iteration a separate manager model reviews what the worker did, reopens unproven ticks, answers `ask` dialogs, waits out usage limits, and can notify a phone through ntfy. |
| [sketch](sketch/) | omp extension (TypeScript) | `/sketch` opens a drawing canvas (laptop touchscreen or phone over the LAN, token-gated) and sends the drawing into the running omp session; the agent can also ask for a drawing with `request_sketch`. |
| [easify](easify/) | slash command + helpers | `/easify` explains a project in plain English with a terminal mermaid diagram and stable block codes for zooming in. |
| [diagramify](diagramify/) | slash command + SVG templates | `/diagramify` draws the same kind of plain-English project map as a layered SVG diagram. |
| [notipill](notipill/) | Python daemon + hook scripts | Small on-screen notification pills for agent CLI hook events (needs attention, turn done), with `notify-send` as fallback. |

seref_manager needs seref_loop next to it (it runs `../seref_loop/bin/seref-loop-gate`), and
diagramify needs easify's `ezcode`; the layout of this repository already provides both.

## Requirements

- Linux. The omp tools were written against omp 18 and use its extension API
  (`@oh-my-pi/pi-coding-agent`); omp's extension API changes between versions, so other
  versions may need adjustments.
- Bun for the TypeScript extensions' tests and for `easify/ezdraw`; Python 3 for `ezcode` and
  notipill (Tk for its pills); bash for the gate and install scripts.
- sketch: optional `rsvg-convert` (librsvg) for SVG sends; opens the canvas in Chromium if found.

## Status and limitations

- Personal tools, used only on my own Linux machines with omp; there is no CI.
- Not security-audited. sketch listens on the LAN while `/sketch` is active (random token per
  omp start, no TLS); seref_manager's ntfy messages go to whatever ntfy server and topic you
  configure (public ntfy.sh topics are readable by anyone who knows the name).
- The `seref_` prefix is just my name; the tools are generic.

## License

MIT, see [LICENSE](LICENSE).
