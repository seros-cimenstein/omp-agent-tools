#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import logging
import math
import os
from pathlib import Path
import queue
import signal
import socket
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont


KINDS = {"attention", "done", "error", "info"}
DEFAULT_CONFIG = "~/.config/notipill/config.json"
DEFAULT_TIMEOUTS = {
    "attention": 10.0,
    "done": 6.0,
    "error": 8.0,
    "info": 6.0,
}

SOCKET_NAME = "notipill.sock"
MAX_DATAGRAM = 8192
UI_POLL_MS = 100
SIGNAL_TICK_MS = 100
TOPMOST_REASSERT_MS = 3000

PILL_BG = "#222222"
TRANSPARENT_BG = "#010101"
TITLE_FG = "#ffffff"
BODY_FG = "#aaaaaa"
DIVIDER_FG = "#333333"
DOT_COLORS = {
    "attention": "#ff9933",
    "done": "#33cc33",
    "error": "#ff4444",
    "info": "#999999",
}
MAX_PILL_WIDTH = 560
DEFAULT_TITLE_SIZE = 14
DEFAULT_BODY_SIZE = 12
DOT_SIZE = 14
LEFT_PAD = 14
TEXT_GAP = 11
RIGHT_PAD = 17
TOP_PAD = 7
BOTTOM_PAD = 7
MIN_SINGLE_ROW_HEIGHT = 34
MIN_DOUBLE_ROW_HEIGHT = 60
ELLIPSIS = "…"


class ConfigError(Exception):
    pass


class NotipillArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


@dataclass(frozen=True)
class Config:
    margin: int
    max_pills: int
    timeouts: dict[str, float]
    title_size: int
    body_size: int


@dataclass(frozen=True)
class Notification:
    source: str
    kind: str
    title: str
    body: str
    timeout: float | None


@dataclass
class ActiveNotification:
    id: int
    notification: Notification
    timeout_after_id: str | None


@dataclass(frozen=True)
class RowMetrics:
    active: ActiveNotification
    height: int
    natural_width: int


def socket_path() -> Path:
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if runtime_dir:
        return Path(runtime_dir) / SOCKET_NAME
    return Path("/tmp") / f"notipill-{os.getuid()}.sock"


def coerce_nonnegative_int(raw: object, name: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ConfigError(f"{name!r} must be a non-negative integer")
    if not math.isfinite(float(raw)) or float(raw) < 0:
        raise ConfigError(f"{name!r} must be a non-negative integer")
    if isinstance(raw, float) and not raw.is_integer():
        raise ConfigError(f"{name!r} must be a non-negative integer")
    return int(raw)


def coerce_positive_int(raw: object, name: str) -> int:
    value = coerce_nonnegative_int(raw, name)
    if value < 1:
        raise ConfigError(f"{name!r} must be a positive integer")
    return value


def coerce_timeout(raw: object, name: str) -> float:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ConfigError(f"{name!r} must be a non-negative number")
    value = float(raw)
    if not math.isfinite(value) or value < 0:
        raise ConfigError(f"{name!r} must be a non-negative number")
    return value


def load_config(path: Path) -> Config:
    margin = 10
    max_pills = 5
    timeouts = dict(DEFAULT_TIMEOUTS)
    title_size = DEFAULT_TITLE_SIZE
    body_size = DEFAULT_BODY_SIZE

    try:
        with path.open("r", encoding="utf-8") as config_file:
            raw = json.load(config_file)
    except FileNotFoundError:
        return Config(margin, max_pills, timeouts, title_size, body_size)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON in {path}: {exc}") from exc
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError("config root must be a JSON object")

    if "margin" in raw:
        margin = coerce_nonnegative_int(raw["margin"], "margin")
    if "max_pills" in raw:
        max_pills = coerce_positive_int(raw["max_pills"], "max_pills")
    if "title_size" in raw:
        title_size = coerce_positive_int(raw["title_size"], "title_size")
    if "body_size" in raw:
        body_size = coerce_positive_int(raw["body_size"], "body_size")
    if "timeouts" in raw:
        raw_timeouts = raw["timeouts"]
        if not isinstance(raw_timeouts, dict):
            raise ConfigError("'timeouts' must be an object")
        for kind, value in raw_timeouts.items():
            if kind not in KINDS:
                raise ConfigError(f"unknown timeout kind: {kind!r}")
            timeouts[kind] = coerce_timeout(value, f"timeouts.{kind}")

    return Config(margin, max_pills, timeouts, title_size, body_size)


def parse_notification(data: bytes) -> Notification:
    try:
        raw = json.loads(data.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError(f"invalid UTF-8: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError("payload must be a JSON object")

    source = raw.get("source")
    kind = raw.get("kind")
    title = raw.get("title")
    body = raw.get("body", "")
    timeout = raw.get("timeout")

    if not isinstance(source, str) or not source:
        raise ValueError("'source' must be a non-empty string")
    if kind not in KINDS:
        raise ValueError("'kind' must be one of attention, done, error, info")
    if not isinstance(title, str) or not title:
        raise ValueError("'title' must be a non-empty string")
    if not isinstance(body, str):
        raise ValueError("'body' must be a string")
    if timeout is None:
        parsed_timeout = None
    else:
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ValueError("'timeout' must be a non-negative number")
        parsed_timeout = float(timeout)
        if not math.isfinite(parsed_timeout) or parsed_timeout < 0:
            raise ValueError("'timeout' must be a non-negative number")

    return Notification(source, kind, title, body, parsed_timeout)


def socket_reader(
    sock: socket.socket,
    notifications: queue.Queue[Notification],
    stop_event: threading.Event,
) -> None:
    sock.settimeout(0.2)
    while not stop_event.is_set():
        try:
            data = sock.recv(MAX_DATAGRAM)
        except socket.timeout:
            continue
        except OSError as exc:
            if not stop_event.is_set():
                logging.error("socket read failed: %s", exc)
            return

        try:
            notification = parse_notification(data)
        except ValueError as exc:
            logging.warning("dropped malformed datagram: %s", exc)
            continue

        notifications.put(notification)


def ellipsize(text: str, font: tkfont.Font, max_width: int) -> str:
    if font.measure(text) <= max_width:
        return text
    if max_width <= 0:
        return ""
    if font.measure(ELLIPSIS) > max_width:
        return ""

    lo = 0
    hi = len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        candidate = text[:mid] + ELLIPSIS
        if font.measure(candidate) <= max_width:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + ELLIPSIS


class NotificationApp:
    def __init__(
        self,
        root: tk.Tk,
        config: Config,
        notifications: queue.Queue[Notification],
        stop_event: threading.Event,
    ) -> None:
        self.root = root
        self.config = config
        self.notifications = notifications
        self.stop_event = stop_event
        self.active: list[ActiveNotification] = []
        self.next_id = 1
        self.row_extents: list[tuple[int, int, int]] = []

        self.root.withdraw()
        self.title_font = tkfont.nametofont("TkDefaultFont").copy()
        self.title_font.configure(size=config.title_size, weight="bold")
        self.body_font = tkfont.nametofont("TkDefaultFont").copy()
        self.body_font.configure(size=config.body_size)

        self.panel = tk.Toplevel(self.root)
        self.panel.withdraw()
        self.panel.overrideredirect(True)
        self.panel.attributes("-topmost", True)
        self.panel.configure(bg=TRANSPARENT_BG)

        self.transparent = True
        try:
            self.panel.attributes("-transparentcolor", TRANSPARENT_BG)
        except tk.TclError:
            self.transparent = False
            self.panel.configure(bg=PILL_BG)

        self.canvas = tk.Canvas(
            self.panel,
            highlightthickness=0,
            bd=0,
            bg=TRANSPARENT_BG if self.transparent else PILL_BG,
        )
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-1>", self.handle_click)

    def start(self) -> None:
        self.root.after(UI_POLL_MS, self.drain_queue)
        self.root.after(SIGNAL_TICK_MS, self.signal_tick)
        self.root.after(TOPMOST_REASSERT_MS, self.reassert_topmost)

    def drain_queue(self) -> None:
        if self.stop_event.is_set():
            self.stop()
            return

        while True:
            try:
                notification = self.notifications.get_nowait()
            except queue.Empty:
                break
            self.add(notification)

        self.root.after(UI_POLL_MS, self.drain_queue)

    def signal_tick(self) -> None:
        if self.stop_event.is_set():
            self.stop()
            return
        self.root.after(SIGNAL_TICK_MS, self.signal_tick)

    def reassert_topmost(self) -> None:
        if self.stop_event.is_set():
            return
        if self.active:
            try:
                self.panel.attributes("-topmost", True)
                self.panel.lift()
            except tk.TclError:
                self.stop_event.set()
        self.root.after(TOPMOST_REASSERT_MS, self.reassert_topmost)

    def add(self, notification: Notification) -> None:
        logging.info('%s/%s "%s"', notification.source, notification.kind, notification.title)
        timeout = (
            notification.timeout
            if notification.timeout is not None
            else self.config.timeouts[notification.kind]
        )
        item_id = self.next_id
        self.next_id += 1
        timeout_ms = max(0, int(timeout * 1000))
        after_id = self.root.after(timeout_ms, self.expire, item_id)
        active = ActiveNotification(item_id, notification, after_id)
        self.active.insert(0, active)

        while len(self.active) > self.config.max_pills:
            old = self.active.pop()
            self.cancel_timeout(old)

        self.redraw()

    def expire(self, item_id: int) -> None:
        active = self.find_active(item_id)
        if active is None:
            return
        active.timeout_after_id = None
        self.remove_active(active, cancel_timeout=False)

    def handle_click(self, event: tk.Event) -> None:
        y = int(event.y)
        for item_id, row_top, row_bottom in self.row_extents:
            if row_top <= y < row_bottom:
                active = self.find_active(item_id)
                if active is not None:
                    self.remove_active(active, cancel_timeout=True)
                return

    def find_active(self, item_id: int) -> ActiveNotification | None:
        for active in self.active:
            if active.id == item_id:
                return active
        return None

    def remove_active(self, active: ActiveNotification, cancel_timeout: bool) -> None:
        if active not in self.active:
            return
        self.active.remove(active)
        if cancel_timeout:
            self.cancel_timeout(active)
        self.redraw()

    def cancel_timeout(self, active: ActiveNotification) -> None:
        if active.timeout_after_id is None:
            return
        try:
            self.root.after_cancel(active.timeout_after_id)
        except tk.TclError:
            pass
        active.timeout_after_id = None

    def redraw(self) -> None:
        if not self.active:
            self.row_extents = []
            self.canvas.delete("all")
            try:
                self.panel.withdraw()
            except tk.TclError:
                pass
            return

        rows = [self.measure_row(active) for active in self.active]
        width = min(MAX_PILL_WIDTH, max(row.natural_width for row in rows))
        height = sum(row.height for row in rows)
        width = max(1, int(width))
        height = max(1, int(height))

        self.canvas.configure(width=width, height=height)
        self.canvas.delete("all")
        self.row_extents = []
        self.draw_panel_background(width, height)

        y = 0
        for index, row in enumerate(rows):
            row_height = row.height
            active = row.active
            self.row_extents.append((active.id, y, y + row_height))
            self.draw_row(active, width, y, row_height)
            y += row_height
            if index < len(rows) - 1:
                self.canvas.create_line(
                    12,
                    y,
                    max(12, width - 12),
                    y,
                    fill=DIVIDER_FG,
                    width=1,
                )

        try:
            screen_width = self.root.winfo_screenwidth()
            x = max(0, screen_width - width - self.config.margin)
            y_pos = self.config.margin
            self.panel.geometry(f"{width}x{height}+{x}+{y_pos}")
            self.panel.deiconify()
            self.panel.lift()
            self.panel.attributes("-topmost", True)
        except tk.TclError:
            return

    def measure_row(self, active: ActiveNotification) -> RowMetrics:
        notification = active.notification
        text_left = LEFT_PAD + DOT_SIZE + TEXT_GAP
        has_body = bool(notification.body)
        title_line = self.title_font.metrics("linespace")
        body_line = self.body_font.metrics("linespace") if has_body else 0
        if has_body:
            height = max(MIN_DOUBLE_ROW_HEIGHT, TOP_PAD + title_line + body_line + BOTTOM_PAD)
        else:
            height = max(MIN_SINGLE_ROW_HEIGHT, title_line + TOP_PAD + BOTTOM_PAD)

        text_width = self.title_font.measure(notification.title)
        if has_body:
            text_width = max(text_width, self.body_font.measure(notification.body))
        natural_width = max(height, text_left + text_width + RIGHT_PAD)
        return RowMetrics(active, height, natural_width)

    def draw_panel_background(self, width: int, height: int) -> None:
        radius = min(height / 2, 12)
        self.canvas.create_rectangle(
            radius,
            0,
            width - radius,
            height,
            fill=PILL_BG,
            outline="",
        )
        self.canvas.create_rectangle(
            0,
            radius,
            width,
            height - radius,
            fill=PILL_BG,
            outline="",
        )
        self.canvas.create_oval(
            0,
            0,
            radius * 2,
            radius * 2,
            fill=PILL_BG,
            outline="",
        )
        self.canvas.create_oval(
            width - radius * 2,
            0,
            width,
            radius * 2,
            fill=PILL_BG,
            outline="",
        )
        self.canvas.create_oval(
            0,
            height - radius * 2,
            radius * 2,
            height,
            fill=PILL_BG,
            outline="",
        )
        self.canvas.create_oval(
            width - radius * 2,
            height - radius * 2,
            width,
            height,
            fill=PILL_BG,
            outline="",
        )

    def draw_row(
        self,
        active: ActiveNotification,
        width: int,
        row_top: int,
        row_height: int,
    ) -> None:
        notification = active.notification
        text_left = LEFT_PAD + DOT_SIZE + TEXT_GAP
        text_max = width - text_left - RIGHT_PAD
        title = ellipsize(notification.title, self.title_font, text_max)
        has_body = bool(notification.body)
        body = ""
        if has_body:
            body = ellipsize(notification.body, self.body_font, text_max)

        tag = f"n{active.id}"
        dot_y = row_top + (row_height - DOT_SIZE) / 2
        dot_x = LEFT_PAD
        self.canvas.create_oval(
            dot_x,
            dot_y,
            dot_x + DOT_SIZE,
            dot_y + DOT_SIZE,
            fill=DOT_COLORS[notification.kind],
            outline="",
            tags=(tag,),
        )

        title_line = self.title_font.metrics("linespace")
        if has_body:
            self.canvas.create_text(
                text_left,
                row_top + TOP_PAD,
                anchor="nw",
                text=title,
                fill=TITLE_FG,
                font=self.title_font,
                tags=(tag,),
            )
            self.canvas.create_text(
                text_left,
                row_top + TOP_PAD + title_line - 1,
                anchor="nw",
                text=body,
                fill=BODY_FG,
                font=self.body_font,
                tags=(tag,),
            )
        else:
            self.canvas.create_text(
                text_left,
                row_top + row_height / 2,
                anchor="w",
                text=title,
                fill=TITLE_FG,
                font=self.title_font,
                tags=(tag,),
            )

    def stop(self) -> None:
        for active in list(self.active):
            self.cancel_timeout(active)
        self.active.clear()
        try:
            self.panel.destroy()
        except tk.TclError:
            pass
        try:
            self.root.quit()
        except tk.TclError:
            pass


def prepare_socket(path: Path) -> socket.socket:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise OSError(f"cannot remove stale socket {path}: {exc}") from exc

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        sock.bind(str(path))
        os.chmod(path, 0o600)
    except OSError:
        sock.close()
        raise
    return sock


def install_signal_handlers(stop_event: threading.Event) -> None:
    def handle_signal(signum: int, frame: object) -> None:
        del signum, frame
        stop_event.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)


def run_daemon(args: argparse.Namespace) -> int:
    logging.basicConfig(level=logging.INFO, format="pill: %(message)s")

    config_path = Path(args.config).expanduser()
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        logging.error("config error: %s", exc)
        return 2

    path = socket_path()
    try:
        sock = prepare_socket(path)
    except OSError as exc:
        logging.error("%s", exc)
        return 1

    stop_event = threading.Event()
    install_signal_handlers(stop_event)
    notifications: queue.Queue[Notification] = queue.Queue()
    reader = threading.Thread(
        target=socket_reader,
        args=(sock, notifications, stop_event),
        name="notipill-socket-reader",
        daemon=True,
    )

    root: tk.Tk | None = None
    reader_started = False
    try:
        root = tk.Tk()
        app = NotificationApp(root, config, notifications, stop_event)
        reader.start()
        reader_started = True
        logging.info("listening on %s", path)
        app.start()
        root.mainloop()
    except KeyboardInterrupt:
        stop_event.set()
    except tk.TclError as exc:
        logging.error("tk error: %s", exc)
        return 1
    finally:
        stop_event.set()
        try:
            sock.close()
        except OSError:
            pass
        if reader_started:
            reader.join(timeout=0.5)
        if root is not None:
            try:
                root.destroy()
            except tk.TclError:
                pass
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            logging.warning("cannot remove socket %s: %s", path, exc)

    return 0


def parse_send_timeout(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise ValueError("--timeout must be a non-negative number") from exc
    if not math.isfinite(timeout) or timeout < 0:
        raise ValueError("--timeout must be a non-negative number")
    return timeout


def run_send(args: argparse.Namespace) -> int:
    if args.kind not in KINDS:
        print("notipill: --kind must be one of attention, done, error, info", file=sys.stderr)
        return 1
    if not args.source:
        print("notipill: --source must be non-empty", file=sys.stderr)
        return 1
    if not args.title:
        print("notipill: --title must be non-empty", file=sys.stderr)
        return 1

    try:
        timeout = parse_send_timeout(args.timeout)
    except ValueError as exc:
        print(f"notipill: {exc}", file=sys.stderr)
        return 1

    payload: dict[str, object] = {
        "source": args.source,
        "kind": args.kind,
        "title": args.title,
        "body": args.body,
    }
    if timeout is not None:
        payload["timeout"] = timeout

    try:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        client = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            client.sendto(data, str(socket_path()))
        finally:
            client.close()
    except Exception as exc:
        print(f"notipill: send failed: {exc}", file=sys.stderr)
        return 1

    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = NotipillArgumentParser(description="Minimal on-screen notification pills.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    daemon = subparsers.add_parser("daemon", help="run the notification daemon")
    daemon.add_argument(
        "--config",
        default=DEFAULT_CONFIG,
        help=f"config path, default: {DEFAULT_CONFIG}",
    )

    send = subparsers.add_parser("send", help="send a notification datagram")
    send.add_argument("--source", required=True)
    send.add_argument("--kind", default="info")
    send.add_argument("--title", required=True)
    send.add_argument("--body", default="")
    send.add_argument("--timeout")

    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.command == "daemon":
        return run_daemon(args)
    if args.command == "send":
        return run_send(args)
    print(f"notipill: unknown command: {args.command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
