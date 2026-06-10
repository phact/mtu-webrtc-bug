# WebRTC data-channel PMTU blackhole (webrtc-rs `INITIAL_MTU = 1228`)

A minimal, fully local reproduction of a silent, permanent WebRTC
data-channel stall: a [webrtc-rs](https://github.com/webrtc-rs/webrtc)
sender emits packets larger than common path MTUs (e.g. the 1280-byte
WireGuard/Tailscale tunnel MTU), so delivery of any message big enough
to fragment depends entirely on IP fragmentation surviving the path.
On a path that drops or refuses fragments, small messages are
delivered fine and **no fragmented message is ever delivered**, with
no error surfaced to either side.

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
WireGuard-family VPNs.

On a healthy path the sending host's kernel rescues this: it splits
the oversized packet into IP fragments at the tun boundary and the
receiver reassembles (verified with tcpdump on a real Tailscale link —
DF is not set, fragments flow, data arrives). The failure mode needs a
path where that rescue does not happen. IP fragmentation is exactly
the mechanism the internet drops most capriciously (see RFC 8900, "IP
Fragmentation Considered Fragile"): firewalls and middleboxes drop
fragments by policy (non-first fragments carry no ports), IPv6
fragments ride extension headers that are widely filtered, and
userspace tunnel stacks have had patchy reassembly support. On any
such path:

1. the full-size fragments never arrive; nothing tells the sender why;
2. SCTP reliably retransmits the same-size chunks into the same hole;
3. on an ordered channel, every later message — however small —
   head-of-line blocks behind the wedged one.

Net effect: `send()` succeeds, `bufferedAmount` climbs and freezes,
the receiver gets nothing, the session eventually dies. It presents as
"the app is blank on this one device" — this repro was originally
built chasing exactly that, in production: an iPad on Tailscale where
the receiver's wire counters froze at ~2 KB while the sender's buffer
sat full, i.e. the fragments demonstrably never arrived. The receiver
(WebKit) was innocent, and the fragment-dropping condition on that
path has since disappeared and resists re-creation — which is the
point: a sender that depends on fragmentation fails at the mercy of
path conditions it can neither see nor control. `blackhole-relay`
below models the fragment-hostile case deterministically.

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
the tunnel (MTU 1280). Run `server.py` (binds dual-stack), open
`rust-offerer.html` on the sender machine and `answerer.html` on the
device, and use the advertise-IP controls to pin the candidate
addresses to the tunnel (the picker prefers the Tailscale addresses,
v6 first; loading the answerer via `http://[<v6 addr>]:8000/` forces
the v6 pair).

Caveat from our own attempts: a real tunnel only reproduces the stall
**while its path is fragment-hostile**. On a healthy path the sender's
kernel fragments at the tun and the receiver reassembles, so all
frames arrive (we verified this with tcpdump on both the v4 and v6
Tailscale pairs — including the exact pair that failed in production
weeks earlier). The production failure mode is real (receiver wire
counters frozen while the sender buffer sat full: fragments never
arrived) but the path condition that caused it is transient and may
not be present when you test. That is why `blackhole-relay` exists:
it makes the fragment-hostile case deterministic. If the tunnel run
does stall for you, capture `pc.getStats()` on the receiver — the data
channel's `messagesReceived` freezing while transport bytes stop is
the signature.

A captured instance of this on a real Tailscale IPv6 link is checked in
at `diagnostics/tailscale-v6-blackhole.pcap` (see `diagnostics/README.md`):
the sender's kernel fragments the 1265-byte SCTP packet into `1232|41`
and retransmits the identical chunk with T3-rtx backoff, never acked,
while small datagrams keep flowing both ways. What that capture does
*not* settle — who actually drops the fragments — is written up in
`diagnostics/who-loses-the-packets.md`.

## Fix directions (upstream)

- Lower the default so the worst-case wire packet fits 1280:
  `1280 − 40 (IPv6) − 8 (UDP) − 37 (DTLS record overhead) = 1195`-byte
  SCTP packet budget.
- Expose the association MTU / `max_payload_size` in `Config`
  (pion/sctp exposes this; libwebrtc keeps its packet budget near 1200
  and rarely trips this).
- Long term: RFC 8899 (DPLPMTUD) — probe with padded packets outside
  the data stream, converge on the real path MTU.
