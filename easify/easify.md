---
description: Plain-English map of this project (or one block of it), drawn right here in the terminal
argument-hint: "[folder | #code]"
---

Explain this project to me like I'm smart but not a programmer.
Target: `$ARGUMENTS` (empty = whole project; `#abcd` = zoom into that block; a folder or file path = zoom into it).

## Ground rules
- Terminal only: answer in this chat. Don't write files, start servers, or open a browser.
- Simple first: what it does for a person, then its parts and how they connect. No code-level detail (functions, classes, variables) unless I zoom into a single file.
- Everyday words. If a tech term is unavoidable, explain it in ≤6 words in brackets, once.
- Only show connections you actually saw in the files (a script running another, a settings file being read, a service starting something at boot). Never guess from names alone; if unsure, leave it out.

## Steps
1. Block codes come from `~/.omp/agent/easify/ezcode` (run it with `--help` if unsure). Paths you give it are relative to the project root that `ezcode --root` prints.
2. Target is a code → `ezcode --find <code>` gives the path. Codes not on disk (`ext:…`, `file::part`) come from an earlier /easify legend in this chat. No match anywhere → say so and stop.
3. Look before drawing: list the target 1–2 levels deep; read README, manifests, entry points, service/config files; skim each part enough to say what it does and what it talks to. Big project: skim, don't read everything.
4. Pick the 3–7 blocks a newcomer must know about at this level: subfolders, main files, plus "You" and the outside things it touches (phone, wifi, another computer, a website, the operating system). Merge outside things into as few boxes as possible (e.g. one "Laptop's system" box, not three). Leave out boring stuff (assets, build output, licenses, lockfiles). More than 7 candidates → group them; the rest is what zooming is for.
   Zooming into a single file: blocks are the file's main jobs, keyed `<file>::<job-name>`.
5. Get codes in one call: `ezcode <key> <key> …` with keys = root-relative paths (folders end with `/`), `ext:<short-name>` for outside things, or `<file>::<job-name>`. Use the printed codes exactly. "You" gets no code.

## Output, in this order
1. **What it is**: 2 sentences max, what it does for whoever uses it.
2. A diagram:
   ```mermaid
   flowchart TD
     you(["You"]) -->|"turn it on"| a["Main script #abcd"]
     a -->|"reads"| b["Settings #ef01"]
     a -->|"talks to over wifi"| c("Other laptop #2345")
   ```
   - `flowchart TD`, no subgraphs (they render sideways and get too wide).
   - ≤ 7 boxes (plus "You"); ≤ 3 arrows leaving any box; prefer arrows that flow downward. Crossing lines make the terminal drawing unreadable, so drop minor connections and mention them in the steps instead.
   - Box label = 1–3 word plain name + space + code. Project parts use `["…"]`; outside things use round `("…")`.
   - Every arrow gets a 1–4 word everyday label ("starts at boot", "sends taps to", "reads settings from").
3. **Blocks**: one line each, same order as the diagram:
   `#abcd` **Name**: what it does, ≤ 15 words. (`path/`)
4. **How it plays out**: 3–5 numbered steps of a typical use, naming blocks by code.
5. Last line: `Zoom: /easify #<code> · Ask: paste a code + your question`, with `<code>` replaced by the code of the block most worth zooming into.

From now on, when I paste a code in this chat, I mean that block. Look it up in the legend (or `ezcode --find`) and answer about that part in the same plain style.
