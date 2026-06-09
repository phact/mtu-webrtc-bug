const enc = new TextEncoder();
const dec = new TextDecoder();

export const LABEL_BYTES = 16;

export const DEFAULT_SEND_OPTIONS = {
  payloadMode: "p2claw",
  pairs: 4,
  responseSize: 220,
  bodySize: 8 * 1024,
  tailSize: 100,
};

export const MESSAGE_PLAN = buildRawMessagePlan(DEFAULT_SEND_OPTIONS);

const P2CLAW_TYPES = {
  req: 0x01,
  res: 0x02,
  data: 0x03,
  end: 0x04,
};

const FLAG_END_STREAM = 0x01;

export function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

export function logger(node) {
  return function log(kind, message) {
    node.textContent += `${timestamp()} ${kind.padEnd(9)} ${message}\n`;
    node.scrollTop = node.scrollHeight;
  };
}

export function setStatus(node, message) {
  node.textContent = `${timestamp()} ${message}`;
}

export function createSessionId(prefix = "mre") {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now().toString(36)}-${suffix}`;
}

export async function copyTextarea(textarea, log, label) {
  if (!textarea.value.trim()) {
    throw new Error(`Nothing to copy from ${label}.`);
  }

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(textarea.value);
  } else {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!document.execCommand("copy")) {
      throw new Error("Browser refused clipboard copy.");
    }
  }

  log("copy", `${label} copied to clipboard`);
}

export async function clearSignal(room) {
  await signalFetch(room, "", { method: "DELETE" });
}

export async function putSignal(room, kind, value) {
  await signalFetch(room, kind, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

export async function getSignal(room, kind) {
  const envelope = await getSignalEnvelope(room, kind);
  return envelope?.value || null;
}

export async function getSignalEnvelope(room, kind) {
  const data = await signalFetch(room, kind);
  if (!data.value) return null;
  return { value: data.value, ts: data.ts || 0 };
}

export async function putSendOptions(room, options) {
  const value = normalizeSendOptions(options);
  if (options.sessionId) value.sessionId = options.sessionId;
  await putSignal(room, "send-options", value);
}

export async function waitForSendOptions(room, log, options = {}) {
  const timeoutMs = typeof options === "number" ? options : options.timeoutMs || 5000;
  const sessionId = typeof options === "number" ? null : options.sessionId || null;
  const started = Date.now();
  let loggedMismatch = false;
  while (Date.now() - started < timeoutMs) {
    const envelope = await getSignalEnvelope(room, "send-options");
    const value = envelope?.value;
    if (value && (!sessionId || value.sessionId === sessionId)) {
      const sendOptions = normalizeSendOptions(value);
      sendOptions.sessionId = value.sessionId || sessionId || null;
      log(
        "signal",
        `received send-options session=${sendOptions.sessionId || "none"} mode=${sendOptions.payloadMode} pairs=${sendOptions.pairs} response=${sendOptions.responseSize} body=${sendOptions.bodySize} tail=${sendOptions.tailSize}`,
      );
      return sendOptions;
    }
    if (value && sessionId && value.sessionId !== sessionId && !loggedMismatch) {
      log("signal", `ignoring send-options for stale session ${value.sessionId || "none"}; want ${sessionId}`);
      loggedMismatch = true;
    }
    await delay(100);
  }
  const sendOptions = normalizeSendOptions();
  sendOptions.sessionId = sessionId || null;
  log("signal", "send-options not found; using defaults");
  return sendOptions;
}

export async function getSignalInfo() {
  const response = await fetch("/signal-info");
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Signal info request failed: ${response.status}`);
  }
  return data;
}

export function chooseAdvertiseIp(info, role) {
  const host = stripBrackets(location.hostname);
  if (role === "answerer" && isUsableIp(info.client_ip)) return info.client_ip;
  if (isUsableIp(host)) return host;

  const serverIps = (info.server_ips || []).map((item) => item.ip).filter(isUsableIp);
  // This harness exists to exercise the constrained (tunnel) path, so the
  // tunnel addresses come FIRST: Tailscale v6, then Tailscale v4, then LAN.
  return (
    serverIps.find(isTailscaleV6) ||
    serverIps.find(isTailscaleIp) ||
    serverIps.find((ip) => ip.startsWith("10.")) ||
    serverIps.find((ip) => ip.startsWith("192.168.")) ||
    serverIps.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    serverIps[0] ||
    ""
  );
}

export function rewriteMdnsHostCandidates(desc, advertiseIp, log) {
  if (!advertiseIp) return desc;

  let replacements = 0;
  const sdp = desc.sdp
    .split("\r\n")
    .map((line) => {
      if (!line.startsWith("a=candidate:")) return line;
      const parts = line.split(" ");
      if (parts[7] !== "host" || !parts[4]?.endsWith(".local")) return line;
      parts[4] = advertiseIp;
      replacements += 1;
      return parts.join(" ");
    })
    .join("\r\n");

  if (replacements) {
    log("candidate", `rewrote ${replacements} mDNS host candidate(s) to ${advertiseIp}`);
  } else {
    log("candidate", `no mDNS host candidates to rewrite for ${advertiseIp}`);
  }

  return { type: desc.type, sdp };
}

function stripBrackets(value) {
  return typeof value === "string" ? value.replace(/^\[|\]$/g, "") : value;
}

function isUsableIp(value) {
  if (typeof value !== "string") return false;
  const v = stripBrackets(value);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    return !v.startsWith("127.") && v !== "0.0.0.0";
  }
  // IPv6 literal: usable unless loopback or link-local.
  if (v.includes(":")) {
    const low = v.toLowerCase();
    return low !== "::1" && !low.startsWith("fe80");
  }
  return false;
}

function isTailscaleIp(value) {
  const parts = value.split(".").map(Number);
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isTailscaleV6(value) {
  // Tailscale's ULA prefix.
  return value.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export async function waitForSignal(room, kind, log, timeoutMs = 120000) {
  return waitForSignalMatch(room, kind, log, () => true, timeoutMs);
}

export async function waitForSignalMatch(room, kind, log, predicate, timeoutMs = 120000) {
  const started = Date.now();
  let logged = false;
  let loggedIgnored = false;

  while (Date.now() - started < timeoutMs) {
    const envelope = await getSignalEnvelope(room, kind);
    if (envelope?.value) {
      if (predicate(envelope.value, envelope)) {
        log("signal", `received ${kind} in room ${room}`);
        return envelope.value;
      }
      if (!loggedIgnored) {
        log("signal", `ignoring ${kind} in room ${room}; predicate did not match`);
        loggedIgnored = true;
      }
    }
    if (!logged) {
      log("signal", `waiting for ${kind} in room ${room}`);
      logged = true;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for ${kind} in room ${room}.`);
}

async function signalFetch(room, kind, init) {
  const cleanRoom = encodeURIComponent((room || "mre").trim() || "mre");
  const cleanKind = kind ? `/${encodeURIComponent(kind)}` : "";
  const response = await fetch(`/signal/${cleanRoom}${cleanKind}`, init);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Signal request failed: ${response.status}`);
  }
  return data;
}

export function createPeerConnection(log, options = {}) {
  // Default is no STUN/TURN: the repro needs the selected path to stay on the
  // local network or tunnel where the low effective PMTU is present.
  const iceServers = options.useStun
    ? [{ urls: "stun:stun.l.google.com:19302" }]
    : [];
  const pc = new RTCPeerConnection({ iceServers });
  const events = [
    "icegatheringstatechange",
    "iceconnectionstatechange",
    "connectionstatechange",
    "signalingstatechange",
  ];

  log("config", `iceServers=${iceServers.length ? iceServers[0].urls : "none"}`);

  for (const eventName of events) {
    pc.addEventListener(eventName, () => {
      log("pc", `${eventName}: ${stateLine(pc)}`);
    });
  }

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      log("candidate", summarizeIceCandidate(event.candidate));
    } else {
      log("candidate", "end-of-candidates");
    }
  });

  pc.addEventListener("icecandidateerror", (event) => {
    log("iceerr", `${event.errorCode || ""} ${event.errorText || ""}`.trim());
  });

  return pc;
}

function stateLine(pc) {
  return [
    `iceGathering=${pc.iceGatheringState}`,
    `ice=${pc.iceConnectionState}`,
    `pc=${pc.connectionState}`,
    `signaling=${pc.signalingState}`,
  ].join(" ");
}

function summarizeIceCandidate(candidate) {
  const parts = candidate.candidate.split(/\s+/);
  const address = candidate.address || parts[4] || "?";
  const port = candidate.port || parts[5] || "?";
  const protocol = candidate.protocol || parts[2] || "?";
  const type = candidate.type || parts[7] || "?";
  const related = candidate.relatedAddress
    ? ` related=${candidate.relatedAddress}:${candidate.relatedPort}`
    : "";
  return `${type} ${protocol} ${address}:${port}${related}`;
}

export function waitForIceGatheringComplete(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve("complete");
  }

  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => finish("timeout"), timeoutMs);
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", check);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve(reason);
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish("complete");
    };
    const onCandidate = (event) => {
      if (!event.candidate) finish("complete");
    };
    pc.addEventListener("icegatheringstatechange", check);
    pc.addEventListener("icecandidate", onCandidate);
    check();
  });
}

export function stringifyDescription(desc) {
  return JSON.stringify({ type: desc.type, sdp: desc.sdp }, null, 2);
}

export function parseDescription(text, expectedType) {
  const value = normalizePaste(text);
  if (!value) {
    throw new Error(`Paste a ${expectedType} first.`);
  }

  try {
    const parsed = JSON.parse(value);
    return validateDescription(parsed, expectedType);
  } catch (error) {
    if (error.message.includes("but this box needs")) throw error;
    // Fall through: raw SDP and paste-damaged JSON are also accepted.
  }

  const recovered = recoverDescriptionJson(value);
  if (recovered) {
    return validateDescription(recovered, expectedType);
  }

  if (value.startsWith("v=0")) {
    return { type: expectedType, sdp: value };
  }

  if (value.startsWith("a=candidate") || /^candidate:/i.test(value) || /^\d+\s+udp\s+/i.test(value)) {
    throw new Error("That paste looks like one ICE candidate, not the full offer/answer. Copy the entire generated text block.");
  }

  if (value.includes('"sdp"') || value.includes("v=0")) {
    throw new Error(`That paste looks incomplete or paste-damaged. Copy the whole generated JSON. ${pasteSummary(value)}`);
  }

  throw new Error(`Expected complete JSON starting with { or raw SDP starting with v=0 for a WebRTC ${expectedType}. ${pasteSummary(value)}`);
}

function normalizePaste(text) {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function validateDescription(parsed, expectedType) {
  if (!parsed || !parsed.type || !parsed.sdp) {
    throw new Error("Parsed text is not a WebRTC session description.");
  }
  if (parsed.type !== expectedType) {
    throw new Error(`Pasted a ${parsed.type}, but this box needs a ${expectedType}.`);
  }
  return { type: parsed.type, sdp: parsed.sdp };
}

function recoverDescriptionJson(value) {
  const typeMatch = value.match(/"type"\s*:\s*"(offer|answer)"/);
  const sdpKeyMatch = value.match(/"sdp"\s*:\s*"/);
  if (!typeMatch || !sdpKeyMatch) return null;

  const sdpStart = sdpKeyMatch.index + sdpKeyMatch[0].length;
  const afterSdp = value.slice(sdpStart);
  const sdpEnd = afterSdp.lastIndexOf('"');
  if (sdpEnd < 0) return null;

  let sdp = afterSdp.slice(0, sdpEnd);
  sdp = sdp
    .replace(/\\r\\n/g, "\r\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  if (!sdp.startsWith("v=0")) return null;
  return { type: typeMatch[1], sdp };
}

function pasteSummary(value) {
  const first = value[0] || "empty";
  const sample = value.slice(0, 24).replace(/\s/g, " ");
  return `Paste length=${value.length}, first=${JSON.stringify(first)}, starts=${JSON.stringify(sample)}.`;
}

export function makePayload(label, byteLength) {
  const bytes = new Uint8Array(byteLength);
  if (byteLength > LABEL_BYTES) {
    crypto.getRandomValues(bytes.subarray(LABEL_BYTES));
  }
  bytes.set(enc.encode(label).slice(0, LABEL_BYTES), 0);
  return bytes;
}


export function buildSendPlan(options = {}) {
  const merged = normalizeSendOptions(options);
  return merged.payloadMode === "raw"
    ? buildRawMessagePlan(merged).map((item) => ({
        ...item,
        payloadMode: "raw",
        payload: makePayload(item.label, item.byteLength),
      }))
    : buildP2clawMessagePlan(merged);
}

export function normalizeSendOptions(options = {}) {
  return {
    payloadMode: options.payloadMode === "raw" || options.payload_mode === "raw" ? "raw" : "p2claw",
    pairs: positiveInt(options.pairs, DEFAULT_SEND_OPTIONS.pairs),
    responseSize: positiveInt(options.responseSize ?? options.response_size, DEFAULT_SEND_OPTIONS.responseSize),
    bodySize: positiveInt(options.bodySize ?? options.body_size, DEFAULT_SEND_OPTIONS.bodySize),
    tailSize: nonNegativeInt(options.tailSize ?? options.tail_size, DEFAULT_SEND_OPTIONS.tailSize),
  };
}

export function buildRawMessagePlan(options = {}) {
  const merged = normalizeSendOptions({ ...options, payloadMode: "raw" });
  const plan = [];
  for (let index = 1; index <= merged.pairs; index += 1) {
    plan.push({ label: `res-${index}-${merged.responseSize}`, byteLength: merged.responseSize });
    plan.push({ label: `body-${index}-${merged.bodySize}`, byteLength: merged.bodySize });
  }
  if (merged.tailSize > 0) {
    plan.push({ label: `tail-${merged.tailSize}`, byteLength: merged.tailSize });
  }
  return plan;
}

export function buildP2clawMessagePlan(options = {}) {
  const merged = normalizeSendOptions(options);
  const plan = [];
  for (const streamId of p2clawResponseStreamIds(merged)) {
    plan.push(...buildP2clawResponsePlanForStream(streamId, merged));
  }
  return plan;
}

export function buildP2clawRequestPlan(options = {}) {
  const merged = normalizeSendOptions(options);
  return p2clawResponseStreamIds(merged).map((streamId) => {
    const payload = encodeP2clawReq(streamId);
    return {
      label: `p2claw-req-${streamId}`,
      payloadMode: "p2claw",
      frameKind: "req",
      streamId,
      byteLength: payload.byteLength,
      payload,
    };
  });
}

export function buildP2clawResponsePlanForStream(streamId, options = {}) {
  const merged = normalizeSendOptions(options);
  const isTail = merged.tailSize > 0 && streamId === merged.pairs + 1;
  if (!Number.isInteger(streamId) || streamId < 1 || (streamId > merged.pairs && !isTail)) {
    return [];
  }

  const bodyBytes = isTail ? merged.tailSize : merged.bodySize;
  const dataLabel = isTail
    ? `p2claw-tail-${streamId}-${bodyBytes}`
    : `p2claw-data-${streamId}-${bodyBytes}`;
  const res = encodeP2clawRes(streamId, merged.responseSize);
  const data = encodeP2clawData(streamId, bodyBytes, true);
  return [
    {
      label: `p2claw-res-${streamId}`,
      payloadMode: "p2claw",
      frameKind: "res",
      streamId,
      byteLength: res.byteLength,
      payload: res,
    },
    {
      label: dataLabel,
      payloadMode: "p2claw",
      frameKind: "data",
      streamId,
      byteLength: data.byteLength,
      payload: data,
    },
  ];
}

function p2clawResponseStreamIds(options) {
  const ids = [];
  for (let streamId = 1; streamId <= options.pairs; streamId += 1) {
    ids.push(streamId);
  }
  if (options.tailSize > 0) ids.push(options.pairs + 1);
  return ids;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function encodeP2clawReq(streamId) {
  return buildFrame(P2CLAW_TYPES.req, FLAG_END_STREAM, (writer) => {
    writer.u32(streamId);
    writer.bytesWithU16Length(enc.encode("GET"));
    writer.bytesWithU16Length(enc.encode(`/mre/${streamId}`));
    writer.u16(2);
    writer.bytesWithU16Length(enc.encode("host"));
    writer.bytesWithU16Length(enc.encode("mre.local"));
    writer.bytesWithU16Length(enc.encode("x-p2claw-mre"));
    writer.bytesWithU16Length(enc.encode("1"));
  });
}

function encodeP2clawRes(streamId, targetTotalBytes) {
  const minTotal = 23;
  const target = Math.max(targetTotalBytes, minTotal);
  const padBytes = target - minTotal;
  return buildFrame(P2CLAW_TYPES.res, 0, (writer) => {
    writer.u32(streamId);
    writer.u16(200);
    writer.u16(1);
    writer.bytesWithU16Length(enc.encode("x-pad"));
    writer.bytesWithU16Length(makeRandomBytes(padBytes));
  });
}

function encodeP2clawData(streamId, bodyBytes, endStream) {
  return buildFrame(P2CLAW_TYPES.data, endStream ? FLAG_END_STREAM : 0, (writer) => {
    writer.u32(streamId);
    writer.raw(makeRandomBytes(bodyBytes));
  });
}

function buildFrame(type, flags, writePayload) {
  const writer = new ByteWriter();
  writer.u32(0);
  const payloadStart = writer.length;
  writer.u8(type);
  writer.u8(flags);
  writePayload(writer);
  const payloadLength = writer.length - payloadStart;
  writer.patchU32(0, payloadLength);
  return writer.toBytes();
}

function makeRandomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  const chunkSize = 65536;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return bytes;
}

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  get length() {
    return this.bytes.length;
  }

  u8(value) {
    this.bytes.push(value & 0xff);
  }

  u16(value) {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff);
  }

  u32(value) {
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  patchU32(offset, value) {
    this.bytes[offset] = (value >>> 24) & 0xff;
    this.bytes[offset + 1] = (value >>> 16) & 0xff;
    this.bytes[offset + 2] = (value >>> 8) & 0xff;
    this.bytes[offset + 3] = value & 0xff;
  }

  raw(bytes) {
    for (const byte of bytes) this.bytes.push(byte);
  }

  bytesWithU16Length(bytes) {
    this.u16(bytes.byteLength);
    this.raw(bytes);
  }

  toBytes() {
    return new Uint8Array(this.bytes);
  }
}

function decodeP2clawFrame(bytes) {
  if (bytes.byteLength < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameLength = view.getUint32(0, false);
  if (frameLength + 4 !== bytes.byteLength || frameLength < 2) return null;

  const type = view.getUint8(4);
  const flags = view.getUint8(5);
  let offset = 6;
  const readU16 = () => {
    if (offset + 2 > bytes.byteLength) throw new Error("truncated u16");
    const value = view.getUint16(offset, false);
    offset += 2;
    return value;
  };
  const readU32 = () => {
    if (offset + 4 > bytes.byteLength) throw new Error("truncated u32");
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  };
  const readBytes = (length) => {
    if (offset + length > bytes.byteLength) throw new Error("truncated bytes");
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const readLpBytes = () => readBytes(readU16());
  const readHeaders = () => {
    const count = readU16();
    for (let i = 0; i < count; i += 1) {
      readLpBytes();
      readLpBytes();
    }
    return count;
  };

  try {
    if (type === P2CLAW_TYPES.req) {
      const streamId = readU32();
      const method = dec.decode(readLpBytes());
      const path = dec.decode(readLpBytes());
      const headers = readHeaders();
      return { kind: "req", streamId, flags, endStream: Boolean(flags & FLAG_END_STREAM), method, path, headers };
    }
    if (type === P2CLAW_TYPES.res) {
      const streamId = readU32();
      const status = readU16();
      const headers = readHeaders();
      return { kind: "res", streamId, flags, endStream: Boolean(flags & FLAG_END_STREAM), status, headers };
    }
    if (type === P2CLAW_TYPES.data) {
      const streamId = readU32();
      const bodyLength = bytes.byteLength - offset;
      return { kind: "data", streamId, flags, endStream: Boolean(flags & FLAG_END_STREAM), bodyLength };
    }
    if (type === P2CLAW_TYPES.end) {
      const streamId = readU32();
      return { kind: "end", streamId, flags, endStream: true };
    }
  } catch {
    return null;
  }
  return null;
}

export async function describeMessage(data) {
  const bytes = new Uint8Array(await toArrayBuffer(data));
  const p2claw = decodeP2clawFrame(bytes);
  const label = dec
    .decode(bytes.slice(0, LABEL_BYTES))
    .replace(/\0/g, "")
    .trim();
  const preview = Array.from(bytes.slice(0, LABEL_BYTES))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");

  return {
    label: p2claw ? `p2claw-${p2claw.kind}-${p2claw.streamId}` : label || "(no ascii label)",
    byteLength: bytes.byteLength,
    preview,
    p2claw,
  };
}

async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (data instanceof Blob) return data.arrayBuffer();
  if (typeof data === "string") return enc.encode(data).buffer;
  throw new Error(`Unsupported message data type: ${typeof data}`);
}

export async function sendTestMessages(dc, log, onSent, options = {}) {
  const plan = buildSendPlan(options);
  for (const item of plan) {
    sendPlanItem(dc, item);
    log(
      "sent",
      `${item.label} mode=${item.payloadMode} byteLength=${item.byteLength} bufferedAmount=${dc.bufferedAmount}`,
    );
    if (onSent) onSent(item);
  }
}

export async function sendP2clawRequests(dc, log, onSent, options = {}) {
  const plan = buildP2clawRequestPlan(options);
  for (const item of plan) {
    sendPlanItem(dc, item);
    log("sent-req", `${item.label} byteLength=${item.byteLength} bufferedAmount=${dc.bufferedAmount}`);
    if (onSent) onSent(item);
  }
}

export function attachP2clawResponder(dc, log, options = {}, onSent) {
  const responseOptions = normalizeSendOptions(options);
  const answered = new Set();
  dc.addEventListener("message", async (event) => {
    const msg = await describeMessage(event.data);
    if (!msg.p2claw || msg.p2claw.kind !== "req") return;

    const streamId = msg.p2claw.streamId;
    if (answered.has(streamId)) {
      log("server", `duplicate p2claw req stream=${streamId}; ignoring`);
      return;
    }
    answered.add(streamId);

    const plan = buildP2clawResponsePlanForStream(streamId, responseOptions);
    if (!plan.length) {
      log("server", `unexpected p2claw req stream=${streamId}; ignoring`);
      return;
    }

    for (const item of plan) {
      sendPlanItem(dc, item);
      log("sent", `${item.label} mode=p2claw byteLength=${item.byteLength} bufferedAmount=${dc.bufferedAmount}`);
      if (onSent) onSent(item);
    }
  });
}

function sendPlanItem(dc, item) {
  if (item.payloadMode === "raw") {
    // Send a Blob to preserve the original browser-control failure mode.
    dc.send(new Blob([item.payload], { type: "application/octet-stream" }));
    return;
  }

  dc.send(item.payload.buffer.slice(item.payload.byteOffset, item.payload.byteOffset + item.payload.byteLength));
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function attachReceiver(dc, log, onMessage) {
  dc.binaryType = "arraybuffer";
  dc.addEventListener("message", async (event) => {
    try {
      const msg = await describeMessage(event.data);
      if (msg.p2claw) {
        const frame = msg.p2claw;
        const detail = frame.kind === "data"
          ? `bodyLength=${frame.bodyLength}`
          : frame.kind === "res"
            ? `status=${frame.status} headers=${frame.headers}`
            : "";
        log(
          "received",
          `p2claw ${frame.kind} stream=${frame.streamId} end=${frame.endStream} ${detail} byteLength=${msg.byteLength}`.trim(),
        );
      } else {
        log(
          "received",
          `${msg.label} byteLength=${msg.byteLength} first16=[${msg.preview}]`,
        );
      }
      if (onMessage) onMessage(msg);
    } catch (error) {
      log("error", error.message);
    }
  });
}

export async function collectPeerDiagnostics(pc) {
  if (!pc) return null;
  const stats = await readInterestingStats(pc);
  return {
    capturedAt: new Date().toISOString(),
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    counters: formatCounters(stats, pc),
    stats,
  };
}

export function startStats(pc, log, currentNode, dumpNode) {
  const tick = async () => {
    if (pc.connectionState === "closed") return;
    try {
      const latest = await readInterestingStats(pc);
      const line = formatCounters(latest, pc);
      currentNode.textContent = line;
      dumpNode.value = JSON.stringify(latest.raw, null, 2);
      log("stats", line);
    } catch (error) {
      log("stats", error.message);
    }
  };

  tick();
  const id = setInterval(tick, 500);
  return () => clearInterval(id);
}

async function readInterestingStats(pc) {
  const report = await pc.getStats();
  const raw = {};
  const dataChannels = [];
  const transports = [];
  const candidatePairs = [];
  const localCandidates = [];
  const remoteCandidates = [];
  const sctpTransports = [];

  for (const [id, stat] of report) {
    const plain = Object.fromEntries(Object.entries(stat));
    const type = stat.type || "";

    if (type === "data-channel" || type === "datachannel") {
      dataChannels.push(plain);
      raw[id] = plain;
    } else if (type === "transport") {
      transports.push(plain);
      raw[id] = plain;
    } else if (type === "candidate-pair") {
      candidatePairs.push(plain);
      raw[id] = plain;
    } else if (type === "local-candidate") {
      localCandidates.push(plain);
      raw[id] = plain;
    } else if (type === "remote-candidate") {
      remoteCandidates.push(plain);
      raw[id] = plain;
    } else if (type === "sctp-transport") {
      sctpTransports.push(plain);
      raw[id] = plain;
    }
  }

  return {
    dataChannels,
    transports,
    candidatePairs,
    localCandidates,
    remoteCandidates,
    sctpTransports,
    raw,
  };
}

function formatCounters(stats, pc) {
  const dc = stats.dataChannels.find((item) => item.label === "p2claw") || stats.dataChannels.find((item) => item.label === "mre") || stats.dataChannels[0] || {};
  const transport = stats.transports[0] || {};
  const selectedPair = selectCandidatePair(stats, transport);
  const pairStates = summarizePairStates(stats.candidatePairs);

  return [
    `ice=${pc.iceConnectionState}`,
    `pc=${pc.connectionState}`,
    `dc.bytesSent=${value(dc.bytesSent)}`,
    `dc.bytesReceived=${value(dc.bytesReceived)}`,
    `dc.messagesSent=${value(dc.messagesSent)}`,
    `dc.messagesReceived=${value(dc.messagesReceived)}`,
    `transport.bytesSent=${value(transport.bytesSent)}`,
    `transport.bytesReceived=${value(transport.bytesReceived)}`,
    `pair.bytesSent=${value(selectedPair.bytesSent)}`,
    `pair.bytesReceived=${value(selectedPair.bytesReceived)}`,
    `pairs=${pairStates}`,
    `localCandidates=${stats.localCandidates.length}`,
    `remoteCandidates=${stats.remoteCandidates.length}`,
  ].join(" ");
}

function selectCandidatePair(stats, transport) {
  if (transport.selectedCandidatePairId && stats.raw[transport.selectedCandidatePairId]) {
    return stats.raw[transport.selectedCandidatePairId];
  }
  return stats.candidatePairs.find((item) => item.selected || item.nominated)
    || stats.candidatePairs.find((item) => item.state === "succeeded")
    || {};
}

function summarizePairStates(candidatePairs) {
  if (!candidatePairs.length) return "none";
  const counts = new Map();
  for (const pair of candidatePairs) {
    const state = pair.state || "unknown";
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  return Array.from(counts, ([state, count]) => `${state}:${count}`).join(",");
}

function value(input) {
  return input === undefined ? "n/a" : input;
}
