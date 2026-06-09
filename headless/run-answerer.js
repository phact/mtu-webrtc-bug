// Headless Chromium answerer for the PMTU-blackhole repro.
//
// ICE will happily route around the relay if it can find any direct pair, so
// this runner forces every packet through the relay:
//   - the GET of the offer is intercepted and every candidate that is not the
//     relayed 127.0.0.2 face is stripped (otherwise the browser dials the
//     sender's real interface addresses directly);
//   - the POST of the answer is intercepted and all host candidates are
//     replaced with a single 127.0.0.3:<RELAY_PORT> candidate (the relay's
//     sender-face; a dedicated port, because Chromium binds 0.0.0.0 and would
//     otherwise own its own candidate port on every loopback alias);
//   - the relay is started in between, once both face addresses are known.
//
// Usage: node run-answerer.js [max-datagram]   (default 1250)
// Env:   SERVER=http://127.0.0.1:8000  signaling server base URL
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");

const MAX_DATAGRAM = process.argv[2] || "1250";
const SERVER = process.env.SERVER || "http://127.0.0.1:8000";
const RELAY_PORT = 47111;
const RELAY_BIN = path.join(
  __dirname, "..", "blackhole-relay", "target", "release", "blackhole-relay",
);

(async () => {
  const offerJson = await (await fetch(`${SERVER}/signal/mre/offer`)).json();
  const offerSdp = offerJson?.value?.sdp;
  if (!offerSdp) {
    console.error("no offer SDP — start the rust sender first");
    process.exit(1);
  }
  const senderCands = [...offerSdp.matchAll(/a=candidate:\S+ \d+ (?:udp|UDP) \d+ (\S+) (\d+) typ host/g)]
    .map((m) => ({ ip: m[1], port: +m[2] }));
  const relayed = senderCands.find((c) => c.ip === "127.0.0.2");
  if (!relayed) {
    console.error("no 127.0.0.2 candidate in offer — run the sender with --advertise-ip 127.0.0.2");
    process.exit(1);
  }
  const psPort = relayed.port;
  console.log(`sender relayed candidate: 127.0.0.2:${psPort} (of ${senderCands.length} host candidates)`);

  let relay = null;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.route("**/signal/mre/offer*", async (route) => {
    const resp = await route.fetch();
    const json = await resp.json();
    if (json?.value?.sdp) {
      json.value.sdp = json.value.sdp
        .split("\r\n")
        .filter((line) => {
          if (!line.startsWith("a=candidate:")) return true;
          const parts = line.split(" ");
          return parts[4] === "127.0.0.2" && +parts[5] === psPort;
        })
        .join("\r\n");
    }
    await route.fulfill({ response: resp, json });
  });

  await page.route("**/signal/mre/answer", async (route) => {
    const body = JSON.parse(route.request().postData());
    let replaced = false;
    const out = [];
    for (const line of body.sdp.split("\r\n")) {
      if (line.startsWith("a=candidate:")) {
        const parts = line.split(" ");
        if (parts[7] === "host" && !replaced) {
          parts[4] = "127.0.0.3";
          parts[5] = String(RELAY_PORT);
          out.push(parts.join(" "));
          replaced = true;
        }
      } else {
        out.push(line);
      }
    }
    body.sdp = out.join("\r\n");
    console.log(`munged answer candidate -> 127.0.0.3:${RELAY_PORT}`);
    relay = spawn(RELAY_BIN, [
      "--sender-face", `127.0.0.3:${RELAY_PORT}`,
      "--answerer-face", `127.0.0.2:${psPort}`,
      "--max-datagram", MAX_DATAGRAM,
    ]);
    relay.stdout.on("data", (d) => process.stdout.write("RELAY  " + d));
    relay.stderr.on("data", (d) => process.stdout.write("RELAY! " + d));
    await new Promise((r) => setTimeout(r, 500));
    await route.continue({ postData: JSON.stringify(body) });
  });

  await page.goto(`${SERVER}/answerer.html`);
  await page.fill("#advertiseIp", "127.0.0.3");
  await page.click("#join");

  let last = "";
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = ((await page.textContent("#status").catch(() => "")) || "").trim();
    if (status !== last) {
      console.log(`t+${i * 3}s  ${status}`);
      last = status;
    }
  }
  console.log(`final: ${last}`);

  await browser.close();
  if (relay) relay.kill();
  process.exit(0);
})();
