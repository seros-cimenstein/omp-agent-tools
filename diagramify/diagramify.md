---
description: Plain-English SVG picture of this project (or one block of it), drawn right here in the terminal
argument-hint: "[folder | #code]"
---

Draw this project for me as an SVG diagram, like I'm smart but not a programmer.
Target: `$ARGUMENTS` (empty = whole project; `#abcd` = zoom into that block; a folder or file path = zoom into it).

## Ground rules
- Terminal only: answer in this chat. The only file you write is the throwaway check render in `/tmp` (step 7), deleted afterwards. Don't start servers or open a browser.
- Simple first: what it does for a person, then its parts and how they connect. No code-level detail (functions, classes, variables) unless I zoom into a single file.
- Everyday words. If a tech term is unavoidable, explain it in ≤6 words, once, in a box detail line or the Blocks list.
- Only show connections you actually saw in the files (a script running another, a settings file being read, a service starting something at boot). Never guess from names alone; if unsure, leave it out.

## Steps
1. Block codes come from `~/.omp/agent/easify/ezcode` (shared with /easify; run it with `--help` if unsure). Paths you give it are relative to the project root that `ezcode --root` prints.
2. Target is a code → `ezcode --find <code>` gives the path. Codes not on disk (`ext:…`, `file::part`) come from an earlier /diagramify or /easify legend in this chat. No match anywhere → say so and stop.
3. Look before drawing: list the target 1–2 levels deep; read README, manifests, entry points, service/config files; skim each part enough to say what it does and what it talks to. Big project: skim, don't read everything.
4. Pick 4–10 blocks a newcomer must know about at this level: subfolders, main files, plus "You" and the outside things it touches (phone, wifi, another computer, a website, the operating system). Merge outside things into as few boxes as possible. Leave out boring stuff (assets, build output, licenses, lockfiles). More candidates → group them; the rest is what zooming is for.
   Zooming into a single file: blocks are the file's main jobs, keyed `<file>::<job-name>`.
5. Get codes in one call: `ezcode <key> <key> …` with keys = root-relative paths (folders end with `/`), `ext:<short-name>` for outside things, or `<file>::<job-name>`. Use the printed codes exactly. "You" gets no code.
6. Draw. Read `~/.omp/agent/diagrams/card.svg` (style) and `~/.omp/agent/diagrams/layers.svg` (layout grid) first, and follow the "SVG diagrams" rules in `~/.omp/agent/RULES.md` (fonts, colours, no background).
   - Group blocks into 2–3 layers (bands), top to bottom: who uses or decides → the main parts → what it runs on or talks to. Name each band by its job in ≤5 words ("Remote · decides", "Safety + vehicle"). A small zoom with ≤4 blocks may skip bands.
   - Use the layers.svg grid: ≤3 boxes per row, ≤2 rows per band, a two-column box for wide things.
   - Box heading = 1–3 word plain name + two spaces + code (`Executor  #3fa2`). Up to 3 detail lines, about 32 characters each, saying what it does.
   - Every arrow gets a 1–2 word label that fits its 65 px gap ("mission", "video", "tool calls"). Solid = does or orders, dashed = what comes back. ≤3 arrows leaving any box; drop minor links and mention them in the steps instead. No arrow may cross a box or a label.
   - Title says what the project is; subtitle says in one line how the layers split the work; an optional 1–2 line footer states the single most important rule or limit.
7. Check before sending: copy the SVG to `/tmp/diagramify-check.svg` with every `var(--x)` replaced by the titanium hex (fg `#e8ecf4`, accent `#00b4ff`, success `#00ff88`, warning `#ffb347`, error `#ff4757`, c1 `#00b4ff`, c2 `#ff6fb0`, c3 `#7ddc6a`, c4 `#c39bff`, c5 `#ffb347`, c6 `#5ce0d0`) plus a `#242424` background rect. View it with `read /tmp/diagramify-check.svg:img`. Fix missing text, overlaps, labels on borders, text spilling out of boxes or low contrast, and re-check until clean. Delete the file.

## Output, in this order
1. **What it is**: 2 sentences max, what it does for whoever uses it.
2. The diagram in one ```svg block (the version without the check background).
3. **Blocks**: one line each, band by band in diagram order:
   `#abcd` **Name**: what it does, ≤ 15 words. (`path/`)
4. **How it plays out**: 3–5 numbered steps of a typical use, naming blocks by code.
5. Last line: `Zoom: /diagramify #<code> · Ask: paste a code + your question`, with `<code>` replaced by the code of the block most worth zooming into.

From now on, when I paste a code in this chat, I mean that block. Look it up in the legend (or `ezcode --find`) and answer about that part in the same plain style.
