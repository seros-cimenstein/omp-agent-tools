# sketch

Draw on your laptop touchscreen or phone and send the drawing straight into the running omp session.

## Install

```bash
./install.sh   # links extension/ to ~/.omp/agent/extensions/sketch
```

Restart omp. Nothing listens on the network until you run `/sketch`.

## Use

| | |
|---|---|
| `/sketch` | Open the canvas in the browser; omp prints the phone link |
| `/sketch diagram` | Put the newest ```svg diagram from the chat (e.g. `/diagramify`) on the canvas |
| `/sketch url` | Only print the links |
| `request_sketch` tool | The agent asks for a drawing and waits; the canvas shows its question, **Answer** replies |

On the canvas: **Send** starts a turn when the agent is idle; while it works, the drawing waits until the current run finishes. **✏️ Pen / ✋ Grab** (next to the status) switches drawing vs moving the page; two fingers always pan and zoom. 🧽 eraser, colours, width, undo/redo, 🖼️ or Ctrl+V to annotate an image, 📊 to pick a chat diagram, 📱 for a QR code to open it on a phone.

## Phone access

The server listens on port 7878 (random if taken), on all interfaces, gated by a random token that changes every omp start. With ufw active, allow the LAN once, e.g.:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 7878 proto tcp
```

`/sketch` prints the exact command for your network.

## Files

- `extension/index.ts`: omp wiring: `/sketch`, `request_sketch`, delivery via `sendUserMessage`, lifecycle
- `extension/server.ts`: Bun HTTP server, token gate, live status (SSE), LAN addresses, firewall hint
- `extension/canvas.html`: the drawing page (no dependencies, works offline)
- `extension/diagrams.ts`: finds chat SVG diagrams and recolours them for white paper
- `extension/qr.ts`: QR code encoder
