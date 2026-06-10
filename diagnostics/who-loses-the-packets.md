# Who loses the packets?

**Answered — see "The answer" at the bottom.** Tailscale's inbound
packet filter drops IPv6 fragments by design, on every platform; the
receiver's OS never sees them. The localization didn't need the
four-point capture this note proposes — two cheaper instruments
settled it (an ICMP ping ladder and the receiver's own drop metrics).
The original analysis is preserved below because the elimination
reasoning is what made the cheap experiments decisive.

## Two different mechanisms produce the same symptom

It's worth separating the relay from the tunnel, because "who loses the
packet" has a *different* answer in each:

- **`blackhole-relay`** sees a 1265-byte-payload UDP datagram, decides
  `28 + 1265 > 1280`, and drops it outright. The packet is never
  fragmented; the relay just refuses to carry it. Who loses it: the
  relay, by construction. This models a link that won't carry the
  packet.
- **The real Tailscale tunnel** does *not* refuse the packet. The
  sender's kernel **fragments** it (we see `1232|41` leave the tun), so
  no single link ever sees an over-MTU packet. The failure is therefore
  **fragment-specific** — a fragment, or a fragment's carrier, is lost
  somewhere — not "the packet was too big for a link."

Same end symptom (the DATA chunk never arrives, the channel wedges,
webrtc-rs never adapts), two different loss mechanisms. The interesting
question is the tunnel one.

## The path, and where fragments are "naked"

A direct Tailscale connection, sender → receiver:

```
sender app
  → sender kernel IPv6 stack        (builds the 1313-byte datagram)
  → sender kernel fragments it       (1280-byte frag0 + 61-byte frag1)   <-- visible in our pcap
  → sender tun (tailscale0)
  → sender tailscaled / wireguard-go (userspace: encrypts EACH fragment
                                      into its own WireGuard UDP datagram)
  → sender NIC → Internet/NAT → receiver NIC
  → receiver tailscaled / wireguard-go (decrypts → 2 inner fragments)
  → receiver tun (tailscale0)
  → receiver kernel IPv6 reassembly  (rebuilds the 1313-byte datagram)
  → receiver app socket
```

The crucial structural fact: **WireGuard encapsulates.** Each inner IPv6
fragment becomes the *payload* of a normal, well-formed outer UDP
datagram (WireGuard port, in-MTU: frag0's carrier is ~1340 B, frag1's is
~120 B). On the physical Internet there are **no visible IP fragments** —
just two ordinary UDP packets. The inner fragments are only "naked,"
inspectable as fragments, in exactly two places: the sender's tun (where
we already see them) and the **receiver's tun**, after decryption.

## What that eliminates

- **"A middlebox/NAT drops the non-first IPv6 fragment" (the classic
  RFC 8900 failure).** Doesn't apply on the physical path here — the
  fragments are hidden inside WireGuard; a middlebox sees normal UDP, not
  a fragment with no L4 ports. Eliminated for the outer path. (It *would*
  apply to a *bare* IPv6 path with no tunnel — worth remembering for
  non-Tailscale repros.)
- **"Generic random packet loss."** The pcap shows **100%** of big
  chunks failing across 8 retransmits over 15 s, while **every** small
  datagram in both directions succeeds in the same window. Deterministic,
  size-correlated loss — not a lossy link.
- **"The receiver's WebKit/SCTP stack is broken."** Small SCTP/DTLS
  chunks are acked throughout; the association is alive. The receiver
  never gets the chunk to mishandle. (This was the original prod
  suspicion; it's wrong.)
- **"send() failed / the sender gave up."** No — the sender faithfully
  fragments and retransmits with correct T3-rtx backoff. The sender is
  behaving exactly as SCTP says it should given no SACK.

## What's left — the real suspects

Given the loss is deterministic, size-correlated, and (per the
encapsulation argument) must occur at or after the receiver's
decrypt→tun→reassembly boundary, the live candidates are:

1. **Receiver-side reassembly never completes** because one of the two
   inner fragments is consistently not delivered to the receiver kernel —
   e.g. wireguard-go / tailscaled drops or mis-sizes one fragment's
   carrier, or the receiver's `nf_conntrack`/reassembly path
   (`net.ipv6.ip6frag_*`, or a firewall reassembling and then dropping
   the >MTU result) discards it. **Most likely.**
2. **A deterministic drop of one carrier datagram** keyed on size or
   timing (e.g. the large frag0 carrier hitting a real physical-path MTU
   below ~1340 that we haven't measured, so *it* gets dropped or needs
   re-fragmentation the outer path won't do). Plausible; measurable.
3. **DERP fallback.** If the pair was relayed rather than direct, the
   effective MTU shrinks further and DERP's handling of the larger
   carrier is another drop point. The inner pcap can't tell direct from
   DERP — `tailscale status` / `tailscale ping` at capture time can.

Between these we cannot choose from a sender-tun capture alone. That's
the whole limitation: we watched the packets leave; we never watched
them arrive (or not).

## The capture that settles it

Reproduce the stall (it reproduced reliably in May 2026; the
fragment-hostile condition is intermittent — see the top-level README)
and capture **simultaneously at four points**, then diff fragment counts
across each boundary:

```sh
# sender, inner (what we already have)
sudo tcpdump -ni tailscale0 -w send-inner.pcap   'ip6 and udp'
# sender, outer (did tailscaled emit BOTH carriers? what size?)
sudo tcpdump -ni <phys>     -w send-outer.pcap    'udp port 41641 or udp port 3478'
# receiver, outer (did BOTH carriers arrive?)
sudo tcpdump -ni <phys>     -w recv-outer.pcap    'udp port 41641 or udp port 3478'
# receiver, inner (do BOTH fragments appear? does a reassembled 1265 datagram
# ever get delivered, or do fragments show up and then nothing?)
sudo tcpdump -ni tailscale0 -w recv-inner.pcap    'ip6 and udp'
```

Reading the diff:

| Observation | Culprit |
|---|---|
| 2 carriers leave sender-outer, <2 arrive receiver-outer | physical path / NAT / DERP drops a carrier (suspect #2/#3) |
| 2 carriers arrive, but <2 inner fragments on receiver-tun | receiver tailscaled / wireguard-go drops a fragment (suspect #1) |
| 2 inner fragments on receiver-tun, no reassembled datagram to the app | receiver kernel/firewall reassembly (suspect #1) |
| reassembled datagram reaches the app, still no SACK | receiver SCTP/DTLS (currently considered eliminated — would reopen it) |

### Cheap discriminator to run first

Make the SCTP packet **fit under 1280 so no fragmentation happens at all**
(lower the sender's effective payload, or test the same path with a
sub-MTU message). If delivery succeeds the moment fragmentation stops,
the loss is conclusively **fragment-specific** (suspects #1–#3), not a
generic size/path problem — and you've confirmed the whole chain hinges
on fragments, which is the entire reason the upstream fix is "don't emit
packets that need fragmenting."

## The answer (2026-06-09): Tailscale's filter drops IPv6 fragments by design

Suspect #1 confirmed, and narrowed to the exact component: the
**receiver's `tailscaled` inbound packet filter**, which discards every
IPv6 fragment — first and non-first alike — before the receiver's OS
ever sees it. The drop is deliberate, cross-platform, and counted under
`reason="acl"` even on a default allow-all tailnet.

### Evidence, in the order it landed

**1. An ICMP ping ladder removes WebRTC from the picture entirely.**
From the sender host, against the original failing iPad's Tailscale
addresses:

```
ping -c 3 -s 100  <ts-v4>   →  3/3 received
ping -c 3 -s 1400 <ts-v4>   →  3/3 received   (IPv4 fragments reassemble)
ping -c 3 -s 100  <ts-v6>   →  3/3 received
ping -c 3 -s 1400 <ts-v6>   →  0/3 — 100% loss (IPv6 fragments die)
```

Deterministic across reruns. The same ladder against a **Linux**
Tailscale peer (kernel-mode networking) gives the identical split —
which eliminates the receiver's OS, WebKit, iOS, and every
platform-specific theory in one stroke. Whatever drops v6 fragments
drops them everywhere Tailscale runs.

**2. The receiver's own metrics confess, with matching arithmetic.**
Each 1400-byte v6 ping fragments into two packets at the sender's tun.
On the receiving node, `tailscale metrics print` shows
`tailscaled_inbound_dropped_packets_total{reason="acl"}` advancing by
**exactly 2 per ping** — 6 after a 3-ping ladder on one receiver, 20
after a 10-ping burst on another. Meanwhile the receiver kernel's
`/proc/net/snmp6` shows `Ip6ReasmReqds = 0`: not one fragment was ever
handed to the OS for reassembly. The loss is strictly inside
`tailscaled`, between WireGuard decrypt and tun injection.

**3. The sender side is clean.** The sender's
`tailscaled_outbound_dropped_packets_total` counters stay flat across
fragment bursts — both fragment carriers are encrypted and shipped, as
the encapsulation argument above predicted.

**4. The source code states the intent.** In `net/packet/packet.go`
(checked at v1.96.4), the IPv6 decoder maps the Fragment extension
header to *unknown protocol* rather than parsing it:

> "Note that this means we don't support fragmentation in IPv6. This
> is fine, because IPv6 strongly mandates that you should not
> fragment."

An unknown-protocol packet can never match an ACL rule, so the filter's
default deny fires — hence `reason="acl"`. The
`Accept, "fragment"` fast-path in `wgengine/filter/filter.go` is
unreachable for IPv6: only the IPv4 decoder ever assigns
`ipproto.Fragment` (IPv4 first fragments get their ports parsed,
non-first fragments pass through — the v4 path even got its own bug
fix in tailscale/tailscale#5727; the v6 path simply opted out).

The rationale in that comment misreads the spec: IPv6 forbids
*in-path* (router) fragmentation, but **source** fragmentation via the
Fragment extension header is legitimate, and RFC 8200 §4.5 requires
end hosts to accept it. A Tailscale node is the end host here, and the
sending kernel did exactly what the RFC permits.

### Revised bottom line

The sender is innocent. The receiver's SCTP is innocent. The receiver's
*operating system* is innocent. The loss is a design decision in
Tailscale's packet filter: IPv6 fragments are classified as
unparseable and silently denied, labeled as an ACL drop, on every
platform. Two consequences follow for this repro:

- On a Tailscale **IPv6** pair, the webrtc-rs stall is not transient or
  path-dependent — it is **deterministic**. Any SCTP packet over the
  ~1232-byte fragmentation threshold wedges the channel, every time.
  (The "condition that resists re-creation" in the top-level README was
  an artifact of sender-side captures: the fragments always left; they
  were always eaten on arrival.)
- `webrtc-rs` remains the accomplice that makes the design decision
  fatal: it is the rare stack that emits UDP datagrams needing v6
  fragmentation, and it has no mechanism — no PMTUD, no probe, no
  error path — to ever learn the fragments died.
