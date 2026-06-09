# WebRTC data-channel PMTU blackhole (webrtc-rs `INITIAL_MTU = 1228`)

A minimal, fully local reproduction of a silent, permanent WebRTC
data-channel stall: a [webrtc-rs](https://github.com/webrtc-rs/webrtc)
sender on any path whose effective MTU is below ~1293 bytes (IPv4) —
for example a WireGuard/Tailscale tunnel at the common 1280 MTU —
delivers small messages fine and **never delivers any message large
enough to fragment**, with no error surfaced to either side.

## The mechanism

`webrtc-sctp` fragments outgoing user messages against a hardcoded,
non-configurable `INITIAL_MTU = 1228`
(`sctp/src/association/mod.rs` in the released crates;
`rtc-sctp/src/config.rs` in the sans-IO rewrite). Nothing ever updates
it: no PMTUD, no ICMP Packet-Too-Big / `MSG_ERRQUEUE` handling, and
retransmissions reuse the original chunk sizes.

A full-size SCTP packet becomes a **1265-byte UDP payload** on the wire
(measured: 1228 + 13 DTLS header + 8 explicit nonce + 16 AEAD tag),
i.e. a 1293-byte IPv4 packet or 1313-byte IPv6 packet. Both exceed
1280 — the IPv6 minimum MTU, and the tunnel MTU used by
WireGuard-family VPNs. On such a path:

1. every full-size fragment is dropped by the link; the ICMP error is
   never read by the userspace stack;
2. SCTP reliably retransmits the same-size chunks into the same hole;
3. on an ordered channel, every later message — however small —
   head-of-line blocks behind the wedged one.

Net effect: `send()` succeeds, `bufferedAmount` climbs and freezes,
the receiver gets nothing, the session eventually dies. It presents as
"the app is blank on this one device" — this repro was originally
built chasing exactly that, on an iPad that turned out to be on
Tailscale. The receiver (WebKit) was innocent.

## One-command repro (Linux, no VPN, no extra devices)

```sh
cd headless && npm install && npx playwright install chromium && cd ..
./repro.sh
```

`repro.sh` runs the full A/B:

- **Blackhole run** — `blackhole-relay` (a tiny UDP forwarder) emulates
  a **1280-byte link** (the WireGuard/Tailscale MTU and the IPv6 floor):
  it drops a datagram when its IPv4 packet (20 IP + 8 UDP + payload)
  exceeds 1280, exactly as a real link of that MTU would. webrtc-rs's
  full-size SCTP packet is a 1293-byte IPv4 packet, so it never fits.
  The headless Chromium receiver gets exactly **one** message
  (`Received 1 message(s): p2claw-res-1`), then silence, while the relay
  logs the same 1293-byte packet retransmitted into the hole.
- **Control run** — same path, relay `--mtu 60000`: all ten messages
  arrive in under three seconds.

Components:

- `server.py` — static files + in-memory HTTP signaling (no SaaS).
- `rust-sender/` — webrtc-rs sender; per stream sends one small `RES`
  frame (~220 B) then one ~8 KiB `DATA` frame, over an ordered data
  channel. (The frames are length-prefixed in a small custom framing;
  any payload large enough to fragment behaves the same.)
- `blackhole-relay/` — UDP relay with two faces; drops a datagram when
  its IPv4 packet (28 B headers + payload) exceeds `--mtu`, forwards the
  rest, logs drops.
- `headless/run-answerer.js` — Playwright Chromium receiver.
- `answerer.html` / `offerer.html` / `rust-offerer.html` — interactive
  browser pages for manual two-device runs.

## ICE will fight you

Be warned when modifying the repro: ICE aggressively routes around the
relay. If the browser can reach the sender on **any** real interface
address (including a VPN address the sender machine happens to have),
the connection succeeds directly and the repro silently passes. The
headless runner therefore strips every non-relay candidate from the
offer and rewrites the answer's candidates to the relay's own
sender-face before they reach either peer. If you run the manual pages
across real devices, verify the *nominated candidate pair* actually
crosses the path you think you're testing before trusting any result.

## Reproducing on a real tunnel

The original field configuration: sender on a host with a Tailscale
interface, receiver a browser on a device whose selected ICE pair rides
the tunnel (MTU 1280). Run `server.py`, open `rust-offerer.html` on the
sender machine and `answerer.html` on the device, and use the
advertise-IP controls to pin the candidate addresses to the tunnel.
No relay is needed in this mode — the tunnel itself is the blackhole.
Small frames arrive; 8 KiB frames never do. Capture `pc.getStats()` on
the receiver: the data channel's `messagesReceived` freezes, and the
transport stops receiving bytes once the first full-size fragment is
dropped.

## Fix directions (upstream)

- Lower the default so the worst-case wire packet fits 1280:
  `1280 − 40 (IPv6) − 8 (UDP) − 37 (DTLS record overhead) = 1195`-byte
  SCTP packet budget.
- Expose the association MTU / `max_payload_size` in `Config`
  (pion/sctp exposes this; libwebrtc keeps its packet budget near 1200
  and rarely trips this).
- Long term: RFC 8899 (DPLPMTUD) — probe with padded packets outside
  the data stream, converge on the real path MTU.
