import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createS3Client } from "../src/adapters/amazonConnect/s3.js";
import { findCustomerPhone, mapToCallRequest, normalizePhone } from "../src/adapters/elevenLabs/mapper.js";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "synthetic_test_secret_" + "s".repeat(12);
const AGENT_MAP = {
  synthetic_agent_001: { wabaId: "synthetic_business_001", wabaPhone: "+12025550111", companyId: "synthetic_company_001" },
};

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(here, "..", "fixtures", "elevenlabs-synthetic", name), "utf-8"));
}

/** Signs the way the SDK expects. This only proves the route and the SDK agree with a secret made up for the test. */
function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v0=` + createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

interface Received {
  headers: http.IncomingHttpHeaders;
  body: any;
}

async function startReceiver(status: number, delayMs = 0, replyBody = "{}") {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      setTimeout(() => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(replyBody);
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { received, port, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

function capturingLogger() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const mk = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => { lines.push({ level, msg, fields }); };
  return { lines, logger: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") } };
}

async function startBridge(receiverPort: number, extra: Record<string, string> = {}) {
  const config = loadConfig({
    OUTBOUND_WEBHOOK_URL: `http://127.0.0.1:${receiverPort}/receive`,
    OUTBOUND_WEBHOOK_SECRET: "o".repeat(24),
    AMAZON_CONNECT_ENABLED: "false",
    ELEVENLABS_ENABLED: "true",
    ELEVENLABS_WEBHOOK_SECRET: SECRET,
    ELEVENLABS_AGENT_MAP: JSON.stringify(AGENT_MAP),
    ...extra,
  });
  const log = capturingLogger();
  const app = buildServer({ config, logger: log.logger });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/webhook/elevenlabs`,
    base: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

async function post(url: string, body: string, signature: string | null, contentType = "application/json") {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (signature !== null) headers["ElevenLabs-Signature"] = signature;
  return fetch(url, { method: "POST", headers, body });
}

async function withBridge<T>(status: number, fn: (b: Awaited<ReturnType<typeof startBridge>>, rx: Awaited<ReturnType<typeof startReceiver>>) => Promise<T>, extra: Record<string, string> = {}) {
  const rx = await startReceiver(status);
  const bridge = await startBridge(rx.port, extra);
  try {
    return await fn(bridge, rx);
  } finally {
    await bridge.close();
    await rx.close();
  }
}

async function send(bridge: { url: string }, event: unknown) {
  const body = JSON.stringify(event);
  return post(bridge.url, body, sign(body));
}

// Cases 1 to 3 and the output contract

test("1 website chat: the number from the configured dynamic variable is used, and the request has the call shape", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { forwarded: true });
    assert.equal(rx.received.length, 1);
    const p = rx.received[0].body;
    assert.equal(p.customer_phone, "+12025550142");
    assert.equal(p.call_uuid, "synthetic_conv_chat_001");
    assert.equal(p.waba_id, "synthetic_business_001");
    assert.equal(p.waba_phone, "+12025550111");
    assert.equal(p.company_id, "synthetic_company_001");
    assert.equal(p.agent_extension, "");
    assert.equal(p.call_direction, "inbound");
    assert.equal(p.call_duration, 95);
    assert.equal(p.call_start_epoch, 1790000000);
    assert.equal(p.recording_filename, null);
    assert.equal(p.widget_source, "");
    assert.equal(p.conversation_source, "elevenlabs");
    assert.equal(p.raw.customerPhoneSource, "dynamic_variable");
    assert.deepEqual(p.conversation.map((t: any) => [t.speaker, t.start, t.end, t.source]), [
      ["agent", 0, 0, "llm"],
      ["customer", 4, 4, "caller"],
      ["agent", 6, 6, "llm"],
      ["customer", 11, 11, "caller"],
    ]);
    assert.deepEqual(Object.keys(p.conversation[0]).sort(), ["cut_off", "end", "language", "source", "speaker", "start", "text", "text_known"]);
    assert.equal(p.conversation[0].language, "en");
    assert.equal(p.conversation[0].cut_off, false);
    assert.equal(p.conversation[0].text_known, true);
    assert.ok(String(rx.received[0].headers["x-bridge-signature"]).startsWith("sha256="));
    assert.equal(rx.received[0].headers["x-bridge-event"], "conversation.call");
    assert.ok(!Number.isNaN(Date.parse(p.timestamp)));
  });
});

test("2 phone call: the documented caller id of an inbound call is the customer, and the two unlabelled numbers are not used", async () => {
  await withBridge(200, async (bridge, rx) => {
    const event = fixture("synthetic-phone-inbound-caller-id.json");
    // Make the unlabelled numbers differ from the caller id so a wrong pick would show.
    event.data.metadata.phone_call.external_number = "+12025550166";
    const res = await send(bridge, event);
    assert.equal(res.status, 200);
    const p = rx.received[0].body;
    assert.equal(p.customer_phone, "+12025550142");
    assert.equal(p.raw.customerPhoneSource, "system__caller_id");
    assert.equal(p.call_direction, "inbound");
  });
});

test("2b an outbound call has no documented customer number, so the caller id is not trusted", async () => {
  await withBridge(200, async (bridge, rx) => {
    const event = fixture("synthetic-phone-inbound-caller-id.json");
    event.data.metadata.phone_call.direction = "outbound";
    await send(bridge, event);
    const p = rx.received[0].body;
    assert.equal(p.customer_phone, "anonymous");
    assert.equal(p.call_direction, "outbound");
    assert.equal(p.raw.customerPhoneSource, "none");
  });
});

test("2c the SMS user number is used, and an unusable candidate is ignored and recorded", () => {
  const sms = findCustomerPhone({ metadata: { sms: { sms_user_phone_number: "+12025550142" } } }, "customer_phone");
  assert.deepEqual([sms.phone, sms.source], ["+12025550142", "sms_user_phone_number"]);
  const bad = findCustomerPhone({ conversation_initiation_client_data: { dynamic_variables: { customer_phone: "call me" } } }, "customer_phone");
  assert.deepEqual([bad.phone, bad.source, bad.rejectedCandidate], [null, "none", true]);
});

test("3 no number anywhere: the literal anonymous is sent and the source is recorded as none", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-no-number.json"));
    assert.equal(res.status, 200);
    const p = rx.received[0].body;
    assert.equal(p.customer_phone, "anonymous");
    assert.equal(p.raw.customerPhoneSource, "none");
  });
});

test("4 a number that appears only in an agent turn is not used", async () => {
  await withBridge(200, async (bridge, rx) => {
    await send(bridge, fixture("synthetic-number-only-in-agent-turn.json"));
    const p = rx.received[0].body;
    assert.equal(p.customer_phone, "anonymous");
    assert.equal(p.raw.customerPhoneSource, "none");
  });
});

test("5 and 6 entries with no message text are skipped and counted, unknown keys are accepted", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-entry-without-message-and-extra-keys.json"));
    assert.equal(res.status, 200);
    const p = rx.received[0].body;
    assert.deepEqual(p.conversation.map((t: any) => t.text), ["Hello, welcome.", "I need help with my invoice."]);
    assert.equal(p.raw.skippedEntries, 3);
    assert.equal(p.customer_phone, "+12025550142");
  });
});

test("a leading zero number is normalised: leading zero, spaces and dashes", () => {
  assert.equal(normalizePhone("020 555 0142"), "+27205550142");
  assert.equal(normalizePhone("+1 202-555-0142"), "+12025550142");
  assert.equal(normalizePhone("12025550142"), "+12025550142");
});

test("the mapper leaves out the call start when it is missing", () => {
  const { payload } = mapToCallRequest({ conversation_id: "c", agent_id: "a", transcript: [{ role: "user", message: "hi", time_in_call_secs: 1 }] }, AGENT_MAP.synthetic_agent_001, { customerPhoneVariable: "customer_phone" });
  assert.equal("call_start_epoch" in payload, false);
  assert.equal(payload.call_duration, 0);
});

// Cases 7 to 10: events and agents the route does not forward

test("7 an audio delivery with a large body is accepted, answered 200 and not forwarded", async () => {
  await withBridge(200, async (bridge, rx) => {
    const audio = Buffer.alloc(12 * 1024 * 1024, 1).toString("base64");
    const event = { type: "post_call_audio", event_timestamp: 1790000800, data: { agent_id: "synthetic_agent_001", conversation_id: "synthetic_conv_audio_001", full_audio: audio } };
    const res = await send(bridge, event);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: true, reason: "event_type" });
    assert.equal(rx.received.length, 0);
    const line = bridge.log.lines.find((l) => l.msg === "Ignoring ElevenLabs event");
    assert.deepEqual(line?.fields, { type: "post_call_audio", conversationId: "synthetic_conv_audio_001" });
  });
});

test("7b a body over the configured limit gets 413", async () => {
  await withBridge(200, async (bridge) => {
    const event = { type: "post_call_audio", data: { conversation_id: "synthetic_conv_audio_002", full_audio: "x".repeat(2 * 1024 * 1024) } };
    const res = await send(bridge, event);
    assert.equal(res.status, 413);
  }, { ELEVENLABS_MAX_BODY_MB: "1" });
});

test("8 a call initiation failure is answered 200 and ignored", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-call-initiation-failure.json"));
    assert.equal(res.status, 200);
    assert.equal(rx.received.length, 0);
  });
});

test("9 an unknown event type is answered 200 and ignored, logging the type and conversation id only", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-unknown-event.json"));
    assert.equal(res.status, 200);
    assert.equal(rx.received.length, 0);
    const line = bridge.log.lines.find((l) => l.msg === "Ignoring ElevenLabs event");
    assert.deepEqual(line?.fields, { type: "synthetic_future_event_type", conversationId: "synthetic_conv_unknown_001" });
  });
});

test("10 an unknown agent id is answered 200 with a warning that has the agent id and conversation id only", async () => {
  await withBridge(200, async (bridge, rx) => {
    const event = fixture("synthetic-chat-with-customer-number.json");
    event.data.agent_id = "synthetic_agent_not_in_map";
    const res = await send(bridge, event);
    assert.equal(res.status, 200);
    assert.equal(rx.received.length, 0);
    const warn = bridge.log.lines.find((l) => l.level === "warn");
    assert.deepEqual(warn?.fields, { agentId: "synthetic_agent_not_in_map", conversationId: "synthetic_conv_chat_001" });
  });
});

test("a conversation with no turns that have text is not sent", async () => {
  await withBridge(200, async (bridge, rx) => {
    const event = fixture("synthetic-no-number.json");
    event.data.transcript = [{ role: "agent", message: null, time_in_call_secs: 0 }];
    const res = await send(bridge, event);
    assert.equal(res.status, 200);
    assert.equal(rx.received.length, 0);
  });
});

// Case 11: signatures

test("11 signature: a bad signature is refused with 401 and nothing is forwarded", async () => {
  await withBridge(200, async (bridge, rx) => {
    const body = JSON.stringify(fixture("synthetic-chat-with-customer-number.json"));
    const res = await post(bridge.url, body, sign(body, "a_different_secret_" + "z".repeat(12)));
    assert.equal(res.status, 401);
    assert.equal(rx.received.length, 0);
  });
});

test("11 signature: a body changed after signing is refused", async () => {
  await withBridge(200, async (bridge, rx) => {
    const body = JSON.stringify(fixture("synthetic-chat-with-customer-number.json"));
    const res = await post(bridge.url, body.replace("solar", "wind"), sign(body));
    assert.equal(res.status, 401);
    assert.equal(rx.received.length, 0);
  });
});

test("11 signature: a missing signature header is refused", async () => {
  await withBridge(200, async (bridge, rx) => {
    const res = await post(bridge.url, JSON.stringify(fixture("synthetic-chat-with-customer-number.json")), null);
    assert.equal(res.status, 401);
    assert.equal(rx.received.length, 0);
  });
});

test("11 signature: a stale timestamp is refused even when the hash matches", async () => {
  await withBridge(200, async (bridge, rx) => {
    const body = JSON.stringify(fixture("synthetic-chat-with-customer-number.json"));
    const stale = Math.floor(Date.now() / 1000) - 31 * 60;
    const res = await post(bridge.url, body, sign(body, SECRET, stale));
    assert.equal(res.status, 401);
    assert.equal(rx.received.length, 0);
  });
});

test("11 signature: a header without a hash or a timestamp is refused before the body is read", async () => {
  await withBridge(200, async (bridge) => {
    const body = JSON.stringify(fixture("synthetic-chat-with-customer-number.json"));
    for (const header of ["garbage", "t=abc,v0=00", `t=${Math.floor(Date.now() / 1000)}`]) {
      const res = await post(bridge.url, body, header);
      assert.equal(res.status, 401, header);
    }
  });
});

test("signature self consistency only: a delivery signed with the test secret in the SDK format is accepted", async () => {
  await withBridge(200, async (bridge) => {
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    assert.equal(res.status, 200);
  });
});

// Case 12: repeats

test("12 the same conversation delivered twice is forwarded both times with the same id, and the receiver decides", async () => {
  const rx = await startReceiver(200, 0, JSON.stringify({ success: true, duplicate: true }));
  const bridge = await startBridge(rx.port);
  try {
    const event = fixture("synthetic-chat-with-customer-number.json");
    assert.equal((await send(bridge, event)).status, 200);
    assert.equal((await send(bridge, event)).status, 200);
    assert.equal(rx.received.length, 2);
    assert.equal(rx.received[0].body.call_uuid, rx.received[1].body.call_uuid);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

// Case 13: receiver outcomes

test("13 a receiver that answers 4xx: one attempt, ElevenLabs gets 200, the log has the conversation id and the reason only", async () => {
  await withBridge(422, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    assert.equal(res.status, 200);
    assert.equal(rx.received.length, 1);
    const warn = bridge.log.lines.find((l) => l.msg.startsWith("Receiver rejected"));
    assert.ok(warn);
    assert.equal(warn.fields.conversationId, "synthetic_conv_chat_001");
    assert.equal(warn.fields.status, 422);
    const logged = JSON.stringify(bridge.log.lines);
    assert.ok(!logged.includes("solar panels"));
    assert.ok(!logged.includes("+12025550142"));
  });
});

test("13 a receiver that answers 5xx: the configured attempts are made, then ElevenLabs gets 503", async () => {
  await withBridge(500, async (bridge, rx) => {
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    assert.equal(res.status, 503);
    assert.equal(rx.received.length, 2);
  });
});

test("13 an unreachable receiver gives 503", async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const bridge = await startBridge(closedPort);
  try {
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    assert.equal(res.status, 503);
  } finally {
    await bridge.close();
  }
});

test("worst case reply time stays inside attempts times timeout plus the backoff", async () => {
  const rx = await startReceiver(200, 3000);
  const bridge = await startBridge(rx.port, { OUTBOUND_WEBHOOK_TIMEOUT_MS: "300", ELEVENLABS_FORWARD_ATTEMPTS: "2" });
  try {
    const started = Date.now();
    const res = await send(bridge, fixture("synthetic-chat-with-customer-number.json"));
    const elapsed = Date.now() - started;
    assert.equal(res.status, 503);
    // 2 attempts of 300 ms plus one 500 ms backoff is 1100 ms. Allow slack for the machine.
    assert.ok(elapsed < 2200, `took ${elapsed} ms`);
    assert.ok(elapsed >= 1000, `took ${elapsed} ms`);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

// Startup, health, agent map, and the other source

test("an ElevenLabs only deployment starts without the Amazon Connect settings or the inbound key", async () => {
  const rx = await startReceiver(200);
  const bridge = await startBridge(rx.port);
  try {
    const health = await (await fetch(bridge.base + "/health")).json();
    assert.deepEqual(health, { ok: true, adapters: { amazonConnect: false, elevenLabs: true } });
    const c = loadConfig({ OUTBOUND_WEBHOOK_URL: "http://localhost:4000/r", OUTBOUND_WEBHOOK_SECRET: "o".repeat(24), AMAZON_CONNECT_ENABLED: "off", ELEVENLABS_ENABLED: "on", ELEVENLABS_WEBHOOK_SECRET: SECRET, ELEVENLABS_AGENT_MAP: JSON.stringify(AGENT_MAP) });
    assert.equal(c.INBOUND_API_KEY, undefined);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

test("Amazon Connect still needs its inbound key, and ElevenLabs needs its secret and a valid agent map", () => {
  const base = { OUTBOUND_WEBHOOK_URL: "http://localhost:4000/r", OUTBOUND_WEBHOOK_SECRET: "o".repeat(24) };
  assert.throws(() => loadConfig({ ...base }), /INBOUND_API_KEY/);
  assert.throws(() => loadConfig({ ...base, AMAZON_CONNECT_ENABLED: "false", ELEVENLABS_ENABLED: "true" }), /ELEVENLABS_WEBHOOK_SECRET/);
  const on = { ...base, AMAZON_CONNECT_ENABLED: "false", ELEVENLABS_ENABLED: "true", ELEVENLABS_WEBHOOK_SECRET: SECRET };
  assert.throws(() => loadConfig({ ...on }), /ELEVENLABS_AGENT_MAP/);
  assert.throws(() => loadConfig({ ...on, ELEVENLABS_AGENT_MAP: "not json" }), /not valid JSON/);
  assert.throws(() => loadConfig({ ...on, ELEVENLABS_AGENT_MAP: JSON.stringify({ a: { wabaId: "x" } }) }), /wabaPhone/);
  assert.throws(() => loadConfig({ ...on, ELEVENLABS_AGENT_MAP: "{}", ELEVENLABS_AGENT_MAP_FILE: "/x/y.json" }), /only one/);
});

test("the agent map can come from a file outside the repository, and a file inside it is refused", () => {
  const base = { OUTBOUND_WEBHOOK_URL: "http://localhost:4000/r", OUTBOUND_WEBHOOK_SECRET: "o".repeat(24), AMAZON_CONNECT_ENABLED: "false", ELEVENLABS_ENABLED: "true", ELEVENLABS_WEBHOOK_SECRET: SECRET };
  const dir = mkdtempSync(join(tmpdir(), "synthetic-agent-map-"));
  const file = join(dir, "map.json");
  writeFileSync(file, JSON.stringify(AGENT_MAP));
  const c = loadConfig({ ...base, ELEVENLABS_AGENT_MAP_FILE: file });
  assert.equal(c.elevenLabsAgentMap.synthetic_agent_001.wabaId, "synthetic_business_001");
  assert.throws(() => loadConfig({ ...base, ELEVENLABS_AGENT_MAP_FILE: join(here, "..", "agent-map.json") }), /outside the repository/);
  assert.throws(() => loadConfig({ ...base, ELEVENLABS_AGENT_MAP_FILE: "relative/map.json" }), /absolute/);
});

test("the Amazon Connect route still works, with its own key, when both sources are on", async () => {
  const rx = await startReceiver(200);
  const config = loadConfig({
    INBOUND_API_KEY: "k".repeat(24),
    OUTBOUND_WEBHOOK_URL: `http://127.0.0.1:${rx.port}/receive`,
    OUTBOUND_WEBHOOK_SECRET: "o".repeat(24),
    AMAZON_CONNECT_DEMO_MODE: "true",
    ELEVENLABS_ENABLED: "true",
    ELEVENLABS_WEBHOOK_SECRET: SECRET,
    ELEVENLABS_AGENT_MAP: JSON.stringify(AGENT_MAP),
  });
  const app = buildServer({ config, s3: createS3Client(config), logger: capturingLogger().logger });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const ev = { "detail-type": "Object Created", source: "aws.s3", detail: { bucket: { name: "b" }, object: { key: "Other/file.json" } } };
    const res = await fetch(`http://127.0.0.1:${port}/webhook/amazon-connect`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "k".repeat(24) }, body: JSON.stringify(ev) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason: "outside_analysis_prefix" });
    const noKey = await fetch(`http://127.0.0.1:${port}/webhook/amazon-connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev) });
    assert.equal(noKey.status, 401);
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    await rx.close();
  }
});
