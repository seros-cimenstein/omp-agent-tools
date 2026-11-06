# sketch

Draw on your laptop touchscreen or phone and send the drawing straight into the running omp session.

## Install

```bash
./install.sh   # links extension/ to ~/.omp/agent/extensions/sketch
```

Restart omp. Nothing listens on the network until you run `/sketch`. SVG sends (below) need `rsvg-convert` (librsvg, e.g. `pacman -S librsvg`); without it the canvas sends PNG.

## Use

| | |
|---|---|
| `/sketch` | Open the canvas in the browser; omp prints the phone link |
| `/sketch diagram` | Put the newest ```svg diagram from the chat (e.g. `/diagramify`) on the canvas |
| `/sketch url` | Only print the links |
| `request_sketch` tool | The agent asks for a drawing and waits; the canvas shows its question, **Answer** replies |

On the canvas: **Send** starts a turn when the agent is idle; while it works, the drawing waits until the current run finishes. **✏️ Pen / ✋ Grab** (next to the status) switches drawing vs moving the page; two fingers always pan and zoom. 🧽 eraser (removes every whole stroke it touches; one undo brings a drag's strokes back), colours, width, undo/redo, 🖼️ or Ctrl+V to annotate an image, 📊 to pick a chat diagram, 📱 for a QR code to open it on a phone.

**What Send transmits.** Ink alone, or ink on a chat diagram, goes as SVG: the diagram's own SVG plus the strokes as paths (simplified to a third of a pixel), typically a few KB instead of a 100+ KB PNG. omp renders it to PNG with librsvg for the model, which only sees raster images, and saves the SVG to `$TMPDIR/omp-sketch/`; the message names that file so the agent can read the exact marks or edit the diagram. Ink on a photo goes as an image: PNG, or JPEG when the PNG would exceed 256 KB, never scaled past the photo's own size.

## Phone access

The server listens on port 7878 (random if taken), on all interfaces, gated by a random token that changes every omp start. With ufw active, allow the LAN once, e.g.:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 7878 proto tcp
```

`/sketch` prints the exact command for your network.

## Files

- `extension/index.ts`: omp wiring: `/sketch`, `request_sketch`, delivery via `sendUserMessage`, lifecycle
- `extension/server.ts`: Bun HTTP server, token gate, live status (SSE), SVG rendering, LAN addresses, firewall hint
- `extension/canvas.html`: the drawing page (no dependencies, works offline)
- `extension/registry.ts`: publishes the server's port, token and pending request in `~/.omp/agent/sketch/<pid>.json` for local tools (DevDeck+)
- `extension/diagrams.ts`: finds chat SVG diagrams and recolours them for white paper
- `extension/qr.ts`: QR code encoder
