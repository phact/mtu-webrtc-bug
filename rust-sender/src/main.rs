use std::collections::HashSet;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use rand::{rngs::StdRng, RngCore, SeedableRng};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate_type::RTCIceCandidateType;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const LABEL_BYTES: usize = 16;

#[derive(Debug, Clone)]
struct Options {
    server: String,
    room: String,
    advertise_ip: Option<String>,
    rewrite_mdns: bool,
    use_stun: bool,
    pairs: usize,
    response_size: usize,
    body_size: usize,
    tail_size: usize,
    payload_mode: PayloadMode,
    keepalive_secs: u64,
    gather_timeout_secs: u64,
    open_timeout_secs: u64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            server: "http://127.0.0.1:8000".to_string(),
            room: "mre".to_string(),
            advertise_ip: None,
            rewrite_mdns: true,
            use_stun: false,
            pairs: 4,
            response_size: 220,
            body_size: 8 * 1024,
            tail_size: 100,
            payload_mode: PayloadMode::P2claw,
            keepalive_secs: 20,
            gather_timeout_secs: 5,
            open_timeout_secs: 60,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SignalGet<T> {
    ok: bool,
    value: Option<T>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SignalAck {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct SessionSignal {
    id: String,
    sender: &'static str,
    #[serde(rename = "createdAt")]
    created_at: u128,
}

#[derive(Debug, Serialize)]
struct SendOptionsSignal {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "payloadMode")]
    payload_mode: String,
    pairs: usize,
    #[serde(rename = "responseSize")]
    response_size: usize,
    #[serde(rename = "bodySize")]
    body_size: usize,
    #[serde(rename = "tailSize")]
    tail_size: usize,
}

#[derive(Debug, Deserialize)]
struct AnswerSignal {
    #[serde(rename = "type")]
    sdp_type: String,
    sdp: String,
    #[serde(rename = "mreSession")]
    mre_session: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadMode {
    Raw,
    P2claw,
}

impl PayloadMode {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "raw" => Ok(Self::Raw),
            "p2claw" => Ok(Self::P2claw),
            other => bail!("unknown payload mode {other:?}; expected raw or p2claw"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::P2claw => "p2claw",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct TestMessage {
    label: String,
    byte_length: usize,
    payload_mode: String,
}

#[derive(Debug, Clone)]
struct OutgoingMessage {
    label: String,
    bytes: Vec<u8>,
    payload_mode: PayloadMode,
}

#[tokio::main]
async fn main() -> Result<()> {
    let opts = Options::parse()?;
    println!("rust-sender opts: {opts:?}");

    let client = Client::new();
    let session_id = new_session_id("rust");
    clear_signal(&client, &opts).await?;
    post_signal(&client, &opts, "session", &session_signal(&session_id)).await?;
    println!("published session {session_id}");
    post_signal(&client, &opts, "send-options", &send_options_signal(&opts, &session_id)).await?;
    println!(
        "published send-options session={} mode={} pairs={} response={} body={} tail={}",
        session_id, opts.payload_mode.as_str(), opts.pairs, opts.response_size, opts.body_size, opts.tail_size
    );

    let mut media = MediaEngine::default();
    media.register_default_codecs()?;

    let mut setting_engine = SettingEngine::default();
    if let Some(ip) = &opts.advertise_ip {
        println!("using {ip} as webrtc-rs 1:1 host candidate IP");
        setting_engine.set_nat_1to1_ips(vec![ip.clone()], RTCIceCandidateType::Host);
    }

    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_setting_engine(setting_engine)
        .build();

    let ice_servers = if opts.use_stun {
        vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }]
    } else {
        Vec::new()
    };

    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers,
            ..Default::default()
        })
        .await?,
    );

    pc.on_ice_connection_state_change(Box::new(|state: RTCIceConnectionState| {
        Box::pin(async move {
            println!("ice state: {state}");
        })
    }));
    pc.on_peer_connection_state_change(Box::new(|state: RTCPeerConnectionState| {
        Box::pin(async move {
            println!("pc state: {state}");
        })
    }));

    let dc_init = RTCDataChannelInit {
        ordered: Some(true),
        ..Default::default()
    };
    let dc = pc.create_data_channel("p2claw", Some(dc_init)).await?;
    let (open_tx, open_rx) = oneshot::channel::<()>();
    let open_tx = Arc::new(Mutex::new(Some(open_tx)));

    dc.on_open(Box::new(move || {
        let open_tx = Arc::clone(&open_tx);
        Box::pin(async move {
            println!("data channel open");
            if let Some(tx) = open_tx.lock().await.take() {
                let _ = tx.send(());
            }
        })
    }));

    let (request_tx, mut request_rx) = mpsc::channel::<u32>(64);
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let request_tx = request_tx.clone();
        Box::pin(async move {
            if let Some(stream_id) = decode_p2claw_req(&msg.data) {
                println!("received p2claw req stream_id={stream_id} byteLength={}", msg.data.len());
                let _ = request_tx.send(stream_id).await;
            } else {
                println!("received non-req data channel message byteLength={}", msg.data.len());
            }
        })
    }));

    let offer = pc.create_offer(None).await?;
    let mut gather_done = pc.gathering_complete_promise().await;
    pc.set_local_description(offer).await?;

    match timeout(Duration::from_secs(opts.gather_timeout_secs), gather_done.recv()).await {
        Ok(_) => println!("ICE gathering complete"),
        Err(_) => println!("ICE gathering timed out after {}s", opts.gather_timeout_secs),
    }

    let mut offer = pc
        .local_description()
        .await
        .ok_or_else(|| anyhow!("missing local description after create_offer"))?;

    if opts.rewrite_mdns {
        if let Some(ip) = &opts.advertise_ip {
            offer.sdp = rewrite_mdns_host_candidates(&offer.sdp, ip);
        }
    }

    println!("publishing offer to room {}", opts.room);
    post_signal(&client, &opts, "offer", &offer).await?;

    println!("waiting for answer from browser answerer for session {session_id}");
    let answer = wait_for_signal_match::<AnswerSignal, _>(
        &client,
        &opts,
        "answer",
        Duration::from_secs(120),
        |answer| answer.mre_session.as_deref() == Some(session_id.as_str()),
    )
    .await?;
    if answer.sdp_type != "answer" {
        bail!("expected answer SDP, got {}", answer.sdp_type);
    }
    pc.set_remote_description(RTCSessionDescription::answer(answer.sdp)?).await?;

    timeout(Duration::from_secs(opts.open_timeout_secs), open_rx)
        .await
        .context("timed out waiting for data channel open")?
        .context("data channel open callback dropped")?;

    let plan = outgoing_plan(&opts);
    let signal_plan = signal_plan(&plan);
    post_signal(&client, &opts, "rust-plan", &signal_plan).await?;

    match opts.payload_mode {
        PayloadMode::Raw => {
            send_burst(&dc, &plan).await?;
            println!("raw burst sent; keeping peer connection alive for {}s", opts.keepalive_secs);
        }
        PayloadMode::P2claw => {
            let answered = serve_p2claw_requests(&dc, &opts, &mut request_rx).await?;
            println!(
                "answered {answered} p2claw request stream(s); keeping peer connection alive for {}s",
                opts.keepalive_secs
            );
        }
    }

    tokio::time::sleep(Duration::from_secs(opts.keepalive_secs)).await;
    pc.close().await?;
    Ok(())
}

impl Options {
    fn parse() -> Result<Self> {
        let mut opts = Options::default();
        let mut args = env::args().skip(1);

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--server" => opts.server = next_value(&mut args, "--server")?,
                "--room" => opts.room = next_value(&mut args, "--room")?,
                "--advertise-ip" => opts.advertise_ip = Some(next_value(&mut args, "--advertise-ip")?),
                "--no-rewrite-mdns" => opts.rewrite_mdns = false,
                "--stun" => opts.use_stun = true,
                "--pairs" => opts.pairs = parse_next(&mut args, "--pairs")?,
                "--response-size" => opts.response_size = parse_next(&mut args, "--response-size")?,
                "--body-size" => opts.body_size = parse_next(&mut args, "--body-size")?,
                "--tail-size" => opts.tail_size = parse_next(&mut args, "--tail-size")?,
                "--payload-mode" => opts.payload_mode = PayloadMode::parse(&next_value(&mut args, "--payload-mode")?)?,
                "--keepalive-secs" => opts.keepalive_secs = parse_next(&mut args, "--keepalive-secs")?,
                "--gather-timeout-secs" => opts.gather_timeout_secs = parse_next(&mut args, "--gather-timeout-secs")?,
                "--open-timeout-secs" => opts.open_timeout_secs = parse_next(&mut args, "--open-timeout-secs")?,
                "-h" | "--help" => {
                    print_help();
                    std::process::exit(0);
                }
                other => bail!("unknown argument {other}; use --help"),
            }
        }

        opts.server = opts.server.trim_end_matches('/').to_string();
        Ok(opts)
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next().ok_or_else(|| anyhow!("missing value for {flag}"))
}

fn parse_next<T>(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let raw = next_value(args, flag)?;
    raw.parse::<T>().map_err(|err| anyhow!("invalid {flag} value {raw:?}: {err}"))
}

fn print_help() {
    println!(
        "Usage: cargo run -- [options]\n\
\nOptions:\n\
  --server URL              Signaling server URL [default: http://127.0.0.1:8000]\n\
  --room NAME               Signaling room [default: mre]\n\
  --advertise-ip IP         Advertise this as webrtc-rs 1:1 host candidate IP\n\
  --no-rewrite-mdns         Leave any mDNS candidates unchanged after gathering\n\
  --stun                    Use stun:stun.l.google.com:19302 as a connectivity control\n\
  --pairs N                 Number of 220B+8KiB pairs [default: 4]\n\
  --response-size BYTES     Small frame size [default: 220]\n\
  --body-size BYTES         Body frame size [default: 8192]\n\
  --tail-size BYTES         Tail frame size [default: 100]\n\
  --keepalive-secs SECS     Keep connection open after burst [default: 20]\n"
    );
}

async fn clear_signal(client: &Client, opts: &Options) -> Result<()> {
    let url = format!("{}/signal/{}", opts.server, opts.room);
    let ack: SignalAck = client.delete(url).send().await?.error_for_status()?.json().await?;
    ensure_ack(ack)
}

async fn post_signal<T: Serialize>(client: &Client, opts: &Options, kind: &str, value: &T) -> Result<()> {
    let url = format!("{}/signal/{}/{}", opts.server, opts.room, kind);
    let ack: SignalAck = client
        .post(url)
        .json(value)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure_ack(ack)
}

async fn wait_for_signal_match<T, F>(
    client: &Client,
    opts: &Options,
    kind: &str,
    max_wait: Duration,
    predicate: F,
) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
    F: Fn(&T) -> bool,
{
    let url = format!("{}/signal/{}/{}", opts.server, opts.room, kind);
    let start = Instant::now();
    let mut logged_ignored = false;

    while start.elapsed() < max_wait {
        let response: SignalGet<T> = client.get(&url).send().await?.error_for_status()?.json().await?;
        if !response.ok {
            bail!("signal GET failed: {}", response.error.unwrap_or_else(|| "unknown error".to_string()));
        }
        if let Some(value) = response.value {
            if predicate(&value) {
                return Ok(value);
            }
            if !logged_ignored {
                println!("ignoring {kind}; signal did not match current session");
                logged_ignored = true;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    bail!("timed out waiting for matching {kind}")
}

fn ensure_ack(ack: SignalAck) -> Result<()> {
    if ack.ok {
        Ok(())
    } else {
        bail!("signal request failed: {}", ack.error.unwrap_or_else(|| "unknown error".to_string()))
    }
}

fn new_session_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random = random_bytes(4);
    format!(
        "{}-{}-{:02x}{:02x}{:02x}{:02x}",
        prefix, millis, random[0], random[1], random[2], random[3]
    )
}

fn session_signal(session_id: &str) -> SessionSignal {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    SessionSignal {
        id: session_id.to_string(),
        sender: "rust",
        created_at,
    }
}

fn send_options_signal(opts: &Options, session_id: &str) -> SendOptionsSignal {
    SendOptionsSignal {
        session_id: session_id.to_string(),
        payload_mode: opts.payload_mode.as_str().to_string(),
        pairs: opts.pairs,
        response_size: opts.response_size,
        body_size: opts.body_size,
        tail_size: opts.tail_size,
    }
}

fn signal_plan(plan: &[OutgoingMessage]) -> Vec<TestMessage> {
    plan.iter()
        .map(|item| TestMessage {
            label: item.label.clone(),
            byte_length: item.bytes.len(),
            payload_mode: item.payload_mode.as_str().to_string(),
        })
        .collect()
}

fn outgoing_plan(opts: &Options) -> Vec<OutgoingMessage> {
    match opts.payload_mode {
        PayloadMode::Raw => raw_outgoing_plan(opts),
        PayloadMode::P2claw => p2claw_outgoing_plan(opts),
    }
}

fn raw_outgoing_plan(opts: &Options) -> Vec<OutgoingMessage> {
    let mut plan = Vec::with_capacity(opts.pairs * 2 + usize::from(opts.tail_size > 0));
    for index in 1..=opts.pairs {
        let label = format!("res-{index}-{}", opts.response_size);
        plan.push(OutgoingMessage {
            bytes: make_payload(&label, opts.response_size),
            label,
            payload_mode: PayloadMode::Raw,
        });
        let label = format!("body-{index}-{}", opts.body_size);
        plan.push(OutgoingMessage {
            bytes: make_payload(&label, opts.body_size),
            label,
            payload_mode: PayloadMode::Raw,
        });
    }
    if opts.tail_size > 0 {
        let label = format!("tail-{}", opts.tail_size);
        plan.push(OutgoingMessage {
            bytes: make_payload(&label, opts.tail_size),
            label,
            payload_mode: PayloadMode::Raw,
        });
    }
    plan
}

fn p2claw_outgoing_plan(opts: &Options) -> Vec<OutgoingMessage> {
    let mut plan = Vec::with_capacity((opts.pairs + usize::from(opts.tail_size > 0)) * 2);
    for stream_id in p2claw_response_stream_ids(opts) {
        plan.extend(p2claw_response_for_stream(opts, stream_id));
    }
    plan
}

fn p2claw_response_stream_ids(opts: &Options) -> Vec<u32> {
    let mut ids = (1..=opts.pairs as u32).collect::<Vec<_>>();
    if opts.tail_size > 0 {
        ids.push(opts.pairs as u32 + 1);
    }
    ids
}

fn p2claw_response_for_stream(opts: &Options, stream_id: u32) -> Vec<OutgoingMessage> {
    let tail_stream_id = opts.pairs as u32 + 1;
    let is_tail = opts.tail_size > 0 && stream_id == tail_stream_id;
    if stream_id == 0 || (stream_id > opts.pairs as u32 && !is_tail) {
        return Vec::new();
    }

    let body_size = if is_tail { opts.tail_size } else { opts.body_size };
    let data_label = if is_tail {
        format!("p2claw-tail-{stream_id}-{body_size}")
    } else {
        format!("p2claw-data-{stream_id}-{body_size}")
    };

    vec![
        OutgoingMessage {
            label: format!("p2claw-res-{stream_id}"),
            bytes: encode_p2claw_res(stream_id, opts.response_size),
            payload_mode: PayloadMode::P2claw,
        },
        OutgoingMessage {
            label: data_label,
            bytes: encode_p2claw_data(stream_id, body_size, true),
            payload_mode: PayloadMode::P2claw,
        },
    ]
}

async fn serve_p2claw_requests(
    dc: &Arc<RTCDataChannel>,
    opts: &Options,
    request_rx: &mut mpsc::Receiver<u32>,
) -> Result<usize> {
    let expected = p2claw_response_stream_ids(opts).len();
    let mut answered = HashSet::new();

    while answered.len() < expected {
        let Some(stream_id) = timeout(Duration::from_secs(60), request_rx.recv())
            .await
            .context("timed out waiting for p2claw req frame")?
        else {
            bail!("p2claw request channel closed")
        };

        if !answered.insert(stream_id) {
            println!("duplicate p2claw req stream_id={stream_id}; ignoring");
            continue;
        }

        let plan = p2claw_response_for_stream(opts, stream_id);
        if plan.is_empty() {
            println!("unexpected p2claw req stream_id={stream_id}; ignoring");
            continue;
        }
        send_burst(dc, &plan).await?;
    }

    Ok(answered.len())
}

async fn send_burst(dc: &Arc<RTCDataChannel>, plan: &[OutgoingMessage]) -> Result<()> {
    let started = Instant::now();
    for item in plan {
        let byte_length = item.bytes.len();
        let sent = dc.send(&Bytes::from(item.bytes.clone())).await?;
        let elapsed_us = started.elapsed().as_micros();
        let buffered = dc.buffered_amount().await;
        println!(
            "sent label={} mode={} byteLength={} writeResult={} bufferedAmount={} elapsed_us={}",
            item.label, item.payload_mode.as_str(), byte_length, sent, buffered, elapsed_us
        );
    }
    Ok(())
}

fn make_payload(label: &str, byte_length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; byte_length];
    if byte_length > LABEL_BYTES {
        let mut rng = StdRng::from_entropy();
        rng.fill_bytes(&mut bytes[LABEL_BYTES..]);
    }
    let label_bytes = label.as_bytes();
    let n = label_bytes.len().min(LABEL_BYTES).min(byte_length);
    bytes[..n].copy_from_slice(&label_bytes[..n]);
    bytes
}


fn decode_p2claw_req(data: &[u8]) -> Option<u32> {
    if data.len() < 16 {
        return None;
    }
    let frame_len = u32::from_be_bytes(data.get(0..4)?.try_into().ok()?) as usize;
    if frame_len + 4 != data.len() || data[4] != 0x01 {
        return None;
    }

    let stream_id = u32::from_be_bytes(data.get(6..10)?.try_into().ok()?);
    let mut offset = 10_usize;
    take_lp_u16(data, &mut offset)?;
    take_lp_u16(data, &mut offset)?;
    let headers = take_u16(data, &mut offset)?;
    for _ in 0..headers {
        take_lp_u16(data, &mut offset)?;
        take_lp_u16(data, &mut offset)?;
    }
    Some(stream_id)
}

fn take_u16(data: &[u8], offset: &mut usize) -> Option<u16> {
    let bytes = data.get(*offset..*offset + 2)?;
    *offset += 2;
    Some(u16::from_be_bytes(bytes.try_into().ok()?))
}

fn take_lp_u16<'a>(data: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    let len = take_u16(data, offset)? as usize;
    let bytes = data.get(*offset..*offset + len)?;
    *offset += len;
    Some(bytes)
}

fn encode_p2claw_res(stream_id: u32, target_total_bytes: usize) -> Vec<u8> {
    let min_total = 23_usize;
    let target = target_total_bytes.max(min_total);
    let pad = random_bytes(target - min_total);
    build_frame(0x02, 0, |out| {
        put_u32(out, stream_id);
        put_u16(out, 200);
        put_u16(out, 1);
        put_lp_u16(out, b"x-pad");
        put_lp_u16(out, &pad);
    })
}

fn encode_p2claw_data(stream_id: u32, body_bytes: usize, end_stream: bool) -> Vec<u8> {
    let body = random_bytes(body_bytes);
    build_frame(0x03, if end_stream { 0x01 } else { 0 }, |out| {
        put_u32(out, stream_id);
        out.extend_from_slice(&body);
    })
}

fn build_frame(type_byte: u8, flags: u8, write_payload: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(type_byte);
    payload.push(flags);
    write_payload(&mut payload);

    let mut out = Vec::with_capacity(payload.len() + 4);
    put_u32(&mut out, payload.len() as u32);
    out.extend_from_slice(&payload);
    out
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn put_lp_u16(out: &mut Vec<u8>, value: &[u8]) {
    put_u16(out, value.len() as u16);
    out.extend_from_slice(value);
}

fn random_bytes(byte_length: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; byte_length];
    let mut rng = StdRng::from_entropy();
    rng.fill_bytes(&mut bytes);
    bytes
}

fn rewrite_mdns_host_candidates(sdp: &str, advertise_ip: &str) -> String {
    let mut replacements = 0_usize;
    let rewritten = sdp
        .split("\r\n")
        .map(|line| {
            if !line.starts_with("a=candidate:") {
                return line.to_string();
            }
            let mut parts: Vec<&str> = line.split(' ').collect();
            if parts.len() > 7 && parts[7] == "host" && parts[4].ends_with(".local") {
                parts[4] = advertise_ip;
                replacements += 1;
                parts.join(" ")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n");

    println!("rewrote {replacements} mDNS host candidate(s) to {advertise_ip}");
    rewritten
}
