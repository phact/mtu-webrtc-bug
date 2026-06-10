# Diagnostics

## `tailscale-v6-blackhole.pcap`

A live capture of the stall on a **real Tailscale IPv6 link** (captured
2026-06-09 on the sender's `tailscale0`; the `fd7a:115c:a1e0::/48`
addresses are Tailscale's CGNAT range). This is the real `webrtc-rs`
sender wedging on a real tunnel — not the relay simulation.

Read it with:

```sh
tcpdump -nr diagnostics/tailscale-v6-blackhole.pcap
```

### What it shows

Sender is `…aaaa:200`, receiver is `…bbbb:1ea2`. (The final hextets
of both addresses are anonymized, with replacements chosen to keep
the UDP checksums valid; ports, sizes, timings, and payloads are
untouched.)

The full-size SCTP packet is a **1265-byte UDP payload** — exactly
`1228 + 13 DTLS + 8 nonce + 16 AEAD`, the number the top-level README
derives. As a 1313-byte IPv6 packet it overflows the 1280 tunnel MTU,
so the **sender's kernel fragments it at the tun**:

```
frag (0|1232) 46442 > 65448: UDP, length 1265
frag (1232|41)
```

`1232 + 41 = 1273 = 1265 payload + 8 UDP header`; the first fragment is
`40 IPv6 + 8 frag-header + 1232 = 1280`, exactly the MTU. DF is not set
(IPv6 fragments at the source).

The same chunk is then retransmitted with SCTP T3-rtx backoff and
**never acknowledged**:

```
23.538  (×3, initial outstanding chunks)
24.745  +1.2s
26.747  +2s
30.747  +4s
38.749  +8s
```

Identical size every time — the sender never adapts, never re-fragments
smaller, never lowers `INITIAL_MTU`. That is the bug.

Meanwhile **small datagrams flow in both directions the entire time**
(65/69/76/108/197-byte packets ping-ponging between the peers). The
DTLS/SCTP association is alive; only the one oversized DATA chunk is
wedged, and on an ordered channel it head-of-line-blocks everything
behind it.

### What it does NOT show — and where that question went

This is a **sender-side** capture. It proves the sender emitted both
fragments and never got a SACK, but it cannot show whether the
fragments reached the receiver. That question is now answered in
`who-loses-the-packets.md`: **Tailscale's inbound packet filter drops
IPv6 fragments by design, on every platform** — established with an
ICMP ping ladder (no WebRTC involved), the receiver's own
`inbound_dropped{reason="acl"}` metric advancing by exactly two per
fragmented ping, and the v6 decoder source, which maps the Fragment
extension header to unknown-protocol so the filter's default deny
fires.
