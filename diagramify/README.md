# diagramify

`/diagramify` is an omp slash command that draws a project (or one block of it) as a layered SVG
diagram, explained in plain English. It is the SVG sibling of [/easify](../easify/): the same
stable block codes, the same zooming (`/diagramify #3fa2`), but the answer is an ```svg block
grouped into 2 to 3 bands (who uses it, the main parts, what it runs on) instead of a terminal
mermaid diagram.

## Files

- `diagramify.md`: the command prompt.
- `card.svg`: style template (fonts, colours via CSS variables, rounded boxes, arrow markers).
- `layers.svg`: layout grid template (bands, up to 3 boxes per row).

Before answering, the agent renders a copy of its SVG with the theme colours filled in on a dark
background to `/tmp/diagramify-check.svg`, looks at the image, fixes overlaps or missing text,
and deletes the file.

## Install

Requires omp and [easify](../easify/) installed first (block codes come from its `ezcode`).

```sh
../easify/install.sh
./install.sh            # links diagramify.md, card.svg and layers.svg into ~/.omp/agent
./install.sh uninstall
```

`PI_CODING_AGENT_DIR` overrides `~/.omp/agent`. Restart omp (or `/reload-plugins`).

## Limitations

- The prompt also points the agent at an "SVG diagrams" section in `~/.omp/agent/RULES.md`
  (fonts, colours, no background), which lives in my personal omp config and is not part of this
  folder; without it the agent relies on `card.svg` and the rules in `diagramify.md`.
- The colour checks are tuned for one dark terminal theme (hex values listed in `diagramify.md`).
- The example labels inside `card.svg` and `layers.svg` come from one of my own projects; they
  only show the style and are replaced in every real diagram.
