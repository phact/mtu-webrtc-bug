//! UDP relay that simulates a path-MTU blackhole: a datagram is dropped when
//! the IP packet it would ride in (IP + UDP headers + payload) exceeds --mtu,
//! exactly as a real link of that MTU would drop it. Everything that fits is
//! forwarded. Two faces, one per peer; each face learns its peer's address
//! from the most recent datagram it received.
//!
//! Point the WebRTC sender's advertised candidate at --sender-face and the
//! answerer's rewritten candidate at --answerer-face, so all traffic crosses
//! the relay in both directions.

use std::net::{SocketAddr, UdpSocket};
use std::process::exit;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

const USAGE: &str = "blackhole-relay --sender-face IP:PORT --answerer-face IP:PORT --mtu BYTES

  Drops a datagram when IP+UDP headers + payload exceed --mtu, exactly as a
  real link of that MTU would. The faces here are IPv4 loopback, so the
  header overhead is 28 bytes (20 IPv4 + 8 UDP). Pass the real tunnel number,
  e.g. --mtu 1280 (WireGuard/Tailscale, IPv6 floor). Set it absurdly high
  (e.g. 60000) for a transparent control run.";

/// IPv4 (20) + UDP (8). The relay faces are 127.0.0.x, so this is the
/// per-datagram header overhead a real IPv4 link would add. (IPv6 would be 48.)
const IPV4_UDP_OVERHEAD: usize = 28;

fn die(msg: &str) -> ! {
    eprintln!("{msg}; use --help");
    exit(2);
}

fn main() {
    let mut sender_face: Option<SocketAddr> = None;
    let mut answerer_face: Option<SocketAddr> = None;
    let mut mtu: Option<usize> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            "--sender-face" => {
                let v = args.next().unwrap_or_else(|| die("missing value for --sender-face"));
                sender_face = Some(v.parse().unwrap_or_else(|_| die("bad --sender-face")));
            }
            "--answerer-face" => {
                let v = args.next().unwrap_or_else(|| die("missing value for --answerer-face"));
                answerer_face = Some(v.parse().unwrap_or_else(|_| die("bad --answerer-face")));
            }
            "--mtu" => {
                let v = args.next().unwrap_or_else(|| die("missing value for --mtu"));
                mtu = Some(v.parse().unwrap_or_else(|_| die("--mtu must be a number")));
            }
            other => die(&format!("unknown argument {other}")),
        }
    }

    let (Some(sender_face), Some(answerer_face), Some(mtu)) =
        (sender_face, answerer_face, mtu)
    else {
        eprintln!("{USAGE}");
        exit(2);
    };

    let sender_sock = Arc::new(UdpSocket::bind(sender_face).expect("bind sender face"));
    let answerer_sock = Arc::new(UdpSocket::bind(answerer_face).expect("bind answerer face"));

    println!(
        "blackhole-relay up: sender-face={sender_face} answerer-face={answerer_face} mtu={mtu} bytes (drops when {IPV4_UDP_OVERHEAD}+payload > mtu)"
    );

    // Last-seen peer address per face, learned from inbound traffic.
    let sender_peer: Arc<Mutex<Option<SocketAddr>>> = Arc::new(Mutex::new(None));
    let answerer_peer: Arc<Mutex<Option<SocketAddr>>> = Arc::new(Mutex::new(None));

    let dropped = Arc::new(AtomicU64::new(0));
    let largest_dropped = Arc::new(AtomicU64::new(0));

    let a = pump(
        "sender->answerer",
        Arc::clone(&sender_sock),
        Arc::clone(&answerer_sock),
        Arc::clone(&sender_peer),
        Arc::clone(&answerer_peer),
        mtu,
        Arc::clone(&dropped),
        Arc::clone(&largest_dropped),
    );
    let b = pump(
        "answerer->sender",
        answerer_sock,
        sender_sock,
        answerer_peer,
        sender_peer,
        mtu,
        dropped,
        largest_dropped,
    );

    a.join().expect("threads should not terminate unexpectedly");
    b.join().expect("threads should not terminate unexpectedly");
}

#[allow(clippy::too_many_arguments)]
fn pump(
    label: &'static str,
    rx_sock: Arc<UdpSocket>,
    tx_sock: Arc<UdpSocket>,
    rx_peer: Arc<Mutex<Option<SocketAddr>>>,
    tx_peer: Arc<Mutex<Option<SocketAddr>>>,
    mtu: usize,
    dropped: Arc<AtomicU64>,
    largest_dropped: Arc<AtomicU64>,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name(label.into())
        .spawn(move || {
            let mut buf = vec![0u8; 65535];
            loop {
                let (len, src) = match rx_sock.recv_from(&mut buf) {
                    Ok(ok) => ok,
                    Err(e) => {
                        eprintln!("[{label}] recv error: {e}");
                        continue;
                    }
                };
                *rx_peer.lock().unwrap() = Some(src);

                // What a real link sees: the full IPv4 packet, not just the payload.
                let packet_len = len + IPV4_UDP_OVERHEAD;
                if packet_len > mtu {
                    let n = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                    let largest = largest_dropped.fetch_max(packet_len as u64, Ordering::Relaxed).max(packet_len as u64);
                    println!(
                        "[{label}] blackholed {len}B payload ({packet_len}B IPv4 packet > mtu {mtu})\t dropped={n} largest_dropped={largest}B"
                    );
                    continue;
                }

                let Some(dst) = *tx_peer.lock().unwrap() else {
                    // Other face hasn't spoken yet; nowhere to forward.
                    continue;
                };
                if let Err(e) = tx_sock.send_to(&buf[..len], dst) {
                    eprintln!("[{label}] send error: {e}");
                }
            }
        })
        .expect("failed to spawn thread")
}
