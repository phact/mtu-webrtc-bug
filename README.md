# WebRTC data-channel PMTU blackhole (webrtc-rs `INITIAL_MTU = 1228`)

A minimal, fully local reproduction of a silent, permanent WebRTC
data-channel stall: a [webrtc-rs](https://github.com/webrtc-rs/webrtc)
sender emits packets larger than common path MTUs (e.g. the 1280-byte
WireGuard/Tailscale tunnel MTU), so delivery of any message big enough
to fragment depends entirely on IP fragmentation surviving the path.
On a path that drops or refuses fragments, small messages are
delivered fine and **no fragmented message is ever delivered**, with
no error surfaced to either side.

One such path turned out to be neither rare nor transient: **Tailscale
drops every IPv6 fragment, on every platform, by design** — its packet
filter classifies the v6 Fragment extension header as an unmatchable
protocol and default-denies it (see
`diagnostics/who-loses-the-packets.md`). Any webrtc-rs data channel
whose ICE-nominated pair is Tailscale-over-IPv6 therefore stalls
deterministically on the first full-size message. The
`blackhole-relay` below reproduces the same failure with no VPN and no
second device.

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
(WebKit) was innocent. The fragment-dropper was eventually identified
as Tailscale's own inbound packet filter (deterministic on IPv6
pairs; the earlier impression that the condition "came and went" was
the ICE pair lottery — v4 and LAN pairs deliver, the v6 pair never
does). The point stands in general: a sender that depends on
fragmentation fails at the mercy of path conditions it can neither
see nor control. `blackhole-relay` below models the fragment-hostile
case with no VPN required.

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

On Tailscale the outcome is decided entirely by which pair gets
nominated: the **IPv6 pair stalls deterministically** (Tailscale's
inbound filter drops all v6 fragments — see
`diagnostics/who-loses-the-packets.md`), the **IPv4 pair delivers**
(v4 fragments get real filter support and reassemble), and a LAN pair
never fragments at all (1500 MTU). So verify the nominated pair is
the v6 tunnel pair before reading anything into a pass. A note of
caution from our own two weeks in the desert: a sender-side tcpdump
showing fragments leaving the tun proves only that they *left* — we
"verified the path healthy" that way while the receiver's filter was
eating both fragments of every message. Watch the receiver.

You can pre-check whether your tunnel is fragment-hostile with no
WebRTC at all:

```sh
ping -c 3 -s 100  <peer-tailscale-v6>   # delivered
ping -c 3 -s 1400 <peer-tailscale-v6>   # 100% loss: fragments dropped
ping -c 3 -s 1400 <peer-tailscale-v4>   # delivered: v4 fragments are fine
```

On the receiving node, `tailscale metrics print` shows
`tailscaled_inbound_dropped_packets_total{reason="acl"}` advancing by
exactly two per lost ping (both fragments), even on an allow-all
tailnet.

If the tunnel run stalls for you, capture `pc.getStats()` on the
receiver — the data channel's `messagesReceived` freezing while
transport bytes stop is the signature.

A captured instance on a real Tailscale IPv6 link is checked in at
`diagnostics/tailscale-v6-blackhole.pcap` (see `diagnostics/README.md`):
the sender's kernel fragments the 1265-byte SCTP packet into `1232|41`
and retransmits the identical chunk with T3-rtx backoff, never acked,
while small datagrams keep flowing both ways. Who drops the fragments
is settled in `diagnostics/who-loses-the-packets.md`: Tailscale's
inbound packet filter, by design, on every platform.

## Fix directions (upstream)

- Lower the default so the worst-case wire packet fits 1280:
  `1280 − 40 (IPv6) − 8 (UDP) − 37 (DTLS record overhead) = 1195`-byte
  SCTP packet budget.
- Expose the association MTU / `max_payload_size` in `Config`
  (pion/sctp exposes this; libwebrtc keeps its packet budget near 1200
  and rarely trips this).
- Long term: RFC 8899 (DPLPMTUD) — probe with padded packets outside
  the data stream, converge on the real path MTU.
