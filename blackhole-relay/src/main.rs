//! UDP relay that simulates a path-MTU blackhole: datagrams whose payload
//! exceeds --max-datagram are silently dropped (with a log line), everything
//! else is forwarded. Two faces, one per peer; each face learns its peer's
//! address from the most recent datagram it received.
//!
//! Point the WebRTC sender's advertised candidate at --sender-face and the
//! answerer's rewritten candidate at --answerer-face, so all traffic crosses
//! the relay in both directions.

use std::net::{SocketAddr, UdpSocket};
use std::process::exit;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

const USAGE: &str = "blackhole-relay --sender-face IP:PORT --answerer-face IP:PORT --max-datagram BYTES

  Drops UDP datagrams whose payload exceeds --max-datagram. Set it absurdly
  high (e.g. 60000) for a transparent control run.";

fn die(msg: &str) -> ! {
    eprintln!("{msg}; use --help");
    exit(2);
}

fn main() {
    let mut sender_face: Option<SocketAddr> = None;
    let mut answerer_face: Option<SocketAddr> = None;
    let mut max_datagram: Option<usize> = None;

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
            "--max-datagram" => {
                let v = args.next().unwrap_or_else(|| die("missing value for --max-datagram"));
                max_datagram = Some(v.parse().unwrap_or_else(|_| die("--max-datagram must be a number")));
            }
            other => die(&format!("unknown argument {other}")),
        }
    }

    let (Some(sender_face), Some(answerer_face), Some(max_datagram)) =
        (sender_face, answerer_face, max_datagram)
    else {
        eprintln!("{USAGE}");
        exit(2);
    };

    let sender_sock = Arc::new(UdpSocket::bind(sender_face).expect("bind sender face"));
    let answerer_sock = Arc::new(UdpSocket::bind(answerer_face).expect("bind answerer face"));

    println!(
        "blackhole-relay up: sender-face={sender_face} answerer-face={answerer_face} max-datagram={max_datagram} bytes"
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
        max_datagram,
        Arc::clone(&dropped),
        Arc::clone(&largest_dropped),
    );
    let b = pump(
        "answerer->sender",
        answerer_sock,
        sender_sock,
        answerer_peer,
        sender_peer,
        max_datagram,
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
    max_datagram: usize,
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

                if len > max_datagram {
                    let n = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                    let largest = largest_dropped.fetch_max(len as u64, Ordering::Relaxed).max(len as u64);
                    println!(
                        "[{label}] blackholed {len} bytes (bytes {len} > max {max_datagram})\t dropped={n} largest_dropped={largest}B"
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
