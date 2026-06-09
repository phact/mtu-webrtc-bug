#!/usr/bin/env python3
import argparse
import json
import socket
import subprocess
import threading
import time
from pathlib import Path
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

SIGNALS = {}
MAX_BODY = 8 * 1024 * 1024
ROOT = Path(__file__).resolve().parent
DIAGNOSTICS_DIR = ROOT / "diagnostics"
DIAGNOSTICS_LOCK = threading.RLock()
DIAGNOSTICS = []
MAX_DIAGNOSTICS = 100
RUST_LOCK = threading.RLock()
RUST_SENDER = {
    "process": None,
    "started_at": None,
    "args": None,
    "lines": [],
    "returncode": None,
}
MAX_RUST_LINES = 500


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/rust-sender/status":
            self.send_json({"ok": True, **rust_sender_snapshot()})
            return

        if path == "/diagnostics":
            self.send_json({"ok": True, "reports": diagnostic_reports()})
            return

        if path == "/diagnostics/latest":
            latest = latest_diagnostic()
            self.send_json({"ok": True, "report": latest})
            return

        if path == "/signal-info":
            self.send_json({
                "ok": True,
                "client_ip": self.client_address[0],
                "server_ips": server_ipv4_addresses(),
            })
            return

        route = self.signal_route()
        if route:
            room, kind = route
            room_state = SIGNALS.get(room, {})
            if kind:
                self.send_json({"ok": True, "room": room, "kind": kind, **room_state.get(kind, {"value": None, "ts": None})})
            else:
                self.send_json({"ok": True, "room": room, "signals": room_state})
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/rust-sender/start":
            try:
                payload = self.read_json_body()
                result = start_rust_sender(payload, self.server.server_address[1])
            except ValueError as error:
                self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            except RuntimeError as error:
                self.send_json({"ok": False, "error": str(error), **rust_sender_snapshot()}, HTTPStatus.CONFLICT)
                return
            self.send_json({"ok": True, **result})
            return

        if path == "/rust-sender/stop":
            self.send_json({"ok": True, **stop_rust_sender()})
            return

        if path == "/diagnostics":
            try:
                payload = self.read_json_body()
                result = store_diagnostic(payload, self.client_address[0])
            except ValueError as error:
                self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"ok": True, **result})
            return

        route = self.signal_route()
        if not route or not route[1]:
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        room, kind = route
        try:
            value = self.read_json_body()
        except ValueError as error:
            self.send_json({"ok": False, "error": str(error)}, HTTPStatus.BAD_REQUEST)
            return

        SIGNALS.setdefault(room, {})[kind] = {"value": value, "ts": time.time()}
        self.send_json({"ok": True, "room": room, "kind": kind})

    def do_DELETE(self):
        route = self.signal_route()
        if not route:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        room, kind = route
        if kind:
            SIGNALS.get(room, {}).pop(kind, None)
        else:
            SIGNALS.pop(room, None)
        self.send_json({"ok": True, "room": room, "kind": kind})

    def signal_route(self):
        parts = [unquote(part) for part in urlparse(self.path).path.split("/") if part]
        if not parts or parts[0] != "signal":
            return None
        if len(parts) == 2:
            return parts[1], None
        if len(parts) == 3:
            return parts[1], parts[2]
        return None

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("Missing JSON body")
        if length > MAX_BODY:
            raise ValueError("JSON body is too large")
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON: {error.msg}") from error

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)




def store_diagnostic(payload, client_ip):
    if not isinstance(payload, dict):
        raise ValueError("diagnostic payload must be a JSON object")

    now = time.time()
    room = clean_string(payload.get("room"), "mre")
    role = clean_string(payload.get("role"), "unknown")
    session_id = clean_string(payload.get("sessionId"), "none")
    base_id = "{}-{}-{}-{}".format(
        time.strftime("%Y%m%d-%H%M%S", time.localtime(now)),
        int((now % 1) * 1000),
        safe_slug(role),
        safe_slug(session_id),
    )

    DIAGNOSTICS_DIR.mkdir(exist_ok=True)
    report_id = base_id
    path = DIAGNOSTICS_DIR / f"{report_id}.json"
    suffix = 1
    while path.exists():
        report_id = f"{base_id}-{suffix}"
        path = DIAGNOSTICS_DIR / f"{report_id}.json"
        suffix += 1

    with RUST_LOCK:
        rust_snapshot = rust_sender_snapshot()
    room_signals = SIGNALS.get(room, {})
    report = {
        "id": report_id,
        "received_at": now,
        "client_ip": client_ip,
        "room": room,
        "role": role,
        "session_id": session_id,
        "payload": payload,
        "rust_sender": rust_snapshot,
        "signals": room_signals,
    }
    path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")

    meta = {
        "id": report_id,
        "received_at": now,
        "client_ip": client_ip,
        "room": room,
        "role": role,
        "session_id": session_id,
        "path": str(path),
        "status": payload.get("status", ""),
        "receivedCount": payload.get("counters", {}).get("receivedCount"),
        "sentRequestCount": payload.get("counters", {}).get("sentRequestCount"),
    }
    with DIAGNOSTICS_LOCK:
        DIAGNOSTICS.append(meta)
        if len(DIAGNOSTICS) > MAX_DIAGNOSTICS:
            del DIAGNOSTICS[:-MAX_DIAGNOSTICS]
    print(f"diagnostic {report_id} saved to {path}")
    return {"id": report_id, "path": str(path), "report": meta}


def diagnostic_reports():
    with DIAGNOSTICS_LOCK:
        reports = list(DIAGNOSTICS)
    if reports:
        return reports
    if not DIAGNOSTICS_DIR.exists():
        return []
    files = sorted(DIAGNOSTICS_DIR.glob("*.json"), reverse=True)[:MAX_DIAGNOSTICS]
    return [{"id": file.stem, "path": str(file)} for file in files]


def latest_diagnostic():
    reports = diagnostic_reports()
    if not reports:
        return None
    latest = reports[-1] if DIAGNOSTICS else reports[0]
    path = Path(latest["path"])
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        return {"id": latest.get("id"), "path": str(path), "error": str(error)}


def safe_slug(value):
    text = str(value or "unknown")[:80]
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in text)
    return cleaned.strip("-_.") or "unknown"


def rust_sender_snapshot():
    with RUST_LOCK:
        proc = RUST_SENDER["process"]
        if proc is not None:
            RUST_SENDER["returncode"] = proc.poll()
        return {
            "running": proc is not None and RUST_SENDER["returncode"] is None,
            "returncode": RUST_SENDER["returncode"],
            "started_at": RUST_SENDER["started_at"],
            "args": RUST_SENDER["args"],
            "lines": list(RUST_SENDER["lines"]),
        }


def start_rust_sender(payload, port):
    with RUST_LOCK:
        proc = RUST_SENDER["process"]
        if proc is not None and proc.poll() is None:
            raise RuntimeError("Rust sender is already running")

        room = clean_string(payload.get("room"), "mre")
        advertise_ip = clean_string(payload.get("advertise_ip"), "")
        server_url = clean_string(payload.get("server"), f"http://127.0.0.1:{port}")
        cmd = ["cargo", "run", "--offline", "--", "--server", server_url, "--room", room]

        if advertise_ip:
            cmd.extend(["--advertise-ip", advertise_ip])
        if bool(payload.get("stun")):
            cmd.append("--stun")
        if not bool(payload.get("rewrite_mdns", True)):
            cmd.append("--no-rewrite-mdns")

        payload_mode = clean_string(payload.get("payload_mode"), "p2claw")
        if payload_mode not in ("p2claw", "raw"):
            raise ValueError("payload_mode must be p2claw or raw")
        cmd.extend(["--payload-mode", payload_mode])

        add_int_arg(cmd, payload, "pairs", "--pairs", minimum=1, maximum=200)
        add_int_arg(cmd, payload, "response_size", "--response-size", minimum=1, maximum=2_000_000)
        add_int_arg(cmd, payload, "body_size", "--body-size", minimum=1, maximum=2_000_000)
        add_int_arg(cmd, payload, "tail_size", "--tail-size", minimum=0, maximum=2_000_000)
        add_int_arg(cmd, payload, "keepalive_secs", "--keepalive-secs", minimum=0, maximum=600)

        RUST_SENDER.update({
            "process": None,
            "started_at": time.time(),
            "args": cmd,
            "lines": [],
            "returncode": None,
        })

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=ROOT / "rust-sender",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as error:
            RUST_SENDER["returncode"] = -1
            append_rust_line(f"failed to start rust sender: {error}")
            raise RuntimeError(str(error)) from error

        RUST_SENDER["process"] = proc
        threading.Thread(target=read_rust_sender_output, args=(proc,), daemon=True).start()
        return rust_sender_snapshot()


def stop_rust_sender():
    with RUST_LOCK:
        proc = RUST_SENDER["process"]
        if proc is None or proc.poll() is not None:
            return rust_sender_snapshot()
        append_rust_line("terminating rust sender")
        proc.terminate()

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        append_rust_line("killing rust sender after terminate timeout")
        proc.kill()
        proc.wait(timeout=5)

    with RUST_LOCK:
        RUST_SENDER["returncode"] = proc.returncode
    return rust_sender_snapshot()


def read_rust_sender_output(proc):
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            append_rust_line(line.rstrip("\n"))
    finally:
        code = proc.wait()
        append_rust_line(f"rust sender exited with code {code}")
        with RUST_LOCK:
            RUST_SENDER["returncode"] = code


def append_rust_line(line):
    with RUST_LOCK:
        RUST_SENDER["lines"].append(line)
        if len(RUST_SENDER["lines"]) > MAX_RUST_LINES:
            del RUST_SENDER["lines"][:-MAX_RUST_LINES]


def clean_string(value, default):
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def add_int_arg(cmd, payload, key, flag, minimum, maximum):
    if key not in payload or payload[key] in (None, ""):
        return
    try:
        value = int(payload[key])
    except (TypeError, ValueError) as error:
        raise ValueError(f"{key} must be an integer") from error
    if value < minimum or value > maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    cmd.extend([flag, str(value)])

def server_ipv4_addresses():
    # v4 + v6 (name kept for the existing call site). Skips loopback and
    # link-local; includes ULA so Tailscale's fd7a:: shows up.
    try:
        data = json.loads(subprocess.check_output(["ip", "-j", "addr"], text=True))
    except Exception:
        return []

    addresses = []
    for item in data:
        if item.get("operstate") == "DOWN":
            continue
        ifname = item.get("ifname", "")
        for info in item.get("addr_info", []):
            addr = info.get("local")
            if not addr:
                continue
            if addr.startswith("127.") or addr == "::1" or addr.lower().startswith("fe80"):
                continue
            family = "v6" if ":" in addr else "v4"
            addresses.append({"interface": ifname, "ip": addr, "family": family})
    return addresses

class DualStackHTTPServer(ThreadingHTTPServer):
    # Bind v6 with V6ONLY off so one socket serves both families.
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description="Static WebRTC MRE server with tiny in-memory signaling.")
    parser.add_argument("--bind", default="::")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    cls = DualStackHTTPServer if ":" in args.bind else ThreadingHTTPServer
    server = cls((args.bind, args.port), Handler)
    print(f"Serving static files and signaling on http://{args.bind}:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
