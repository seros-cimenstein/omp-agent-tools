# easify

`/easify` is an omp slash command that explains a project in plain English, for someone who is
smart but not a programmer. The agent reads the project and answers in the terminal with a short
summary, a mermaid diagram of 3 to 7 blocks, one line per block and a few steps of how it is used.
Every block gets a stable 4-character code (`#3fa2`), so you can zoom in with `/easify #3fa2` or
paste a code with a question.

## Files

- `easify.md`: the command prompt (rules for the diagram and the answer layout).
- `ezcode`: Python 3 script that turns a project-relative path or label into its code
  (first 4 hex digits of its SHA-1) and finds the path for a code (`ezcode --find 3fa2`).
  The same path in the same project always gets the same code, in every session.
- `ezdraw`: Bun script the agent pipes its mermaid block into before answering. It prints the
  diagram as the terminal will draw it and lists breaks of the layout rules (more than 2 arrows
  out of a box, a second arrow into a box, upward arrows, long labels). On first use it installs
  the [beautiful-mermaid](https://www.npmjs.com/package/beautiful-mermaid) renderer into
  `~/.cache/easify` with `bun add`.

## Install

Requires omp, Python 3, git (for finding the project root) and Bun (for `ezdraw`).

```sh
./install.sh            # links easify.md, ezcode and ezdraw into ~/.omp/agent
./install.sh uninstall
```

`PI_CODING_AGENT_DIR` overrides `~/.omp/agent`. Restart omp (or `/reload-plugins`), then run
`/easify`, `/easify some/folder` or `/easify #code` inside a project.

## Limitations

The quality of the explanation depends on the model; the rules ask it to show only connections it
actually saw in the files, but they cannot enforce that. `ezdraw` checks the diagram's layout, not
whether it is correct.
