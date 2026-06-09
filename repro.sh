#!/usr/bin/env bash
# One-command A/B repro of the webrtc-rs PMTU blackhole. Linux.
#
#   ./repro.sh
#
# Run 1: relay emulates a 1280-byte link (WireGuard/Tailscale, IPv6 floor) ->
#        webrtc-rs's full-size SCTP packet is a 1293-byte IPv4 packet, doesn't
#        fit, gets dropped -> receiver gets exactly one message, then permanent
#        silence.
# Run 2: same path, relay --mtu 60000 (transparent) -> all ten messages arrive.
#
# Prereqs: rust toolchain, python3, node with `npm install` done in headless/
# (or NODE_PATH pointing at a node_modules that has playwright + its chromium).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8077}"
SERVER="http://127.0.0.1:${PORT}"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "== building =="
cargo build --release --manifest-path "$ROOT/blackhole-relay/Cargo.toml"
cargo build --release --manifest-path "$ROOT/rust-sender/Cargo.toml"

echo "== starting signaling server on :$PORT =="
python3 "$ROOT/server.py" --bind 127.0.0.1 --port "$PORT" >/tmp/mre-server.log 2>&1 &
PIDS+=($!)
sleep 0.5

run_pass() {
  local mtu="$1" expect="$2" label="$3"
  echo
  echo "== $label (mtu=$mtu) =="
  "$ROOT/rust-sender/target/release/rust-sender" \
    --server "$SERVER" --room mre --advertise-ip 127.0.0.2 \
    --keepalive-secs 45 >/tmp/mre-sender.log 2>&1 &
  local sender_pid=$!
  PIDS+=("$sender_pid")
  for _ in $(seq 1 30); do
    grep -q 'waiting for answer' /tmp/mre-sender.log && break
    sleep 1
  done
  local out
  out="$(SERVER="$SERVER" node "$ROOT/headless/run-answerer.js" "$mtu")"
  echo "$out"
  kill "$sender_pid" 2>/dev/null || true
  if echo "$out" | grep -q "final:.*$expect"; then
    echo "-- $label: PASS"
  else
    echo "-- $label: FAIL (expected status matching \"$expect\")"
    return 1
  fi
}

run_pass 1280  "Received 1 message(s)"  "blackhole run"
run_pass 60000 "Received 10 message(s)" "control run"

echo
echo "== A/B complete: same path, only --mtu differed =="
