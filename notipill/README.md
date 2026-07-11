# notipill

`notipill` is a minimal on-screen notification daemon for LLM CLI hook events. It listens on a private Unix datagram socket and shows small Tk pills at the top-right of the screen.

## Protocol

Daemon:

```sh
python3 notipill.py daemon
```

Client:

```sh
notipill.py send --source claude --kind attention --title "Claude · project" --body "needs input"
```

The datagram payload is JSON:

```json
{"source":"claude","kind":"attention","title":"Claude · project","body":"needs input","timeout":10}
```

`kind` must be one of `attention`, `done`, `error`, or `info`. `timeout` is optional and overrides the configured per-kind timeout.

## Install

Install the daemon script under:

```sh
~/.local/lib/notipill/notipill.py
```

Expose it as `~/.local/bin/notipill` with a symlink to the executable script, or with a two-line launcher:

```sh
#!/usr/bin/env sh
exec /usr/bin/python3 "$HOME/.local/lib/notipill/notipill.py" "$@"
```

Install `notipill.service` as a user unit, for example under `~/.config/systemd/user/notipill.service`, then enable it with `systemctl --user enable --now notipill.service`.

Deploy the scripts in `wrappers/` over the existing `agent-notify-*` hook scripts in `~/.local/bin/`. They send to notipill first and fall back to the original `notify-send` commands when the daemon is unavailable.
