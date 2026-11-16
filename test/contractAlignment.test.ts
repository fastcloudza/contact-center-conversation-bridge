import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildNormalizedConversation } from "../src/ingest.js";
import { mapToSourceTranscript, mapToIdentityInfo } from "../src/adapters/amazonConnect/mapper.js";
import { mapToSourceTranscript as mapGenesys, } from "../src/adapters/genesysCloud/mapper.js";
import { mapToCallRequest } from "../src/adapters/elevenLabs/mapper.js";
import { resolveCustomerPhone, usablePhone, toEpochSeconds } from "../src/contract.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createS3Client } from "../src/adapters/amazonConnect/s3.js";
import type { ContactLensAnalysisJson, CtrRecord } from "../src/adapters/amazonConnect/types.js";
import type { IdentityInfo, SourceTranscript } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loadJson = (...parts: string[]) => JSON.parse(readFileSync(path.join(here, "..", "fixtures", ...parts), "utf-8"));
const voice: ContactLensAnalysisJson = loadJson("amazon-connect", "sample-analysis.json");
const chat1: ContactLensAnalysisJson = loadJson("amazon-connect", "captured-chat-1.json");
const chat2: ContactLensAnalysisJson = loadJson("amazon-connect", "captured-chat-2.json");
const genesysDoc = loadJson("genesys-cloud", "sample-transcript-guess.json");
const logger = createLogger("error");
const VOICE_KEY = "Analysis/Voice/2026/09/14/a1b2c3d4-e5f6-7890-abcd-ef1234567890_analysis_2026-09-14T12:00:00Z.json";
const RECEIVER = { businessId: "synthetic_business_001", businessPhone: "+12025550111", countryCode: "1" };

const NOBODY: IdentityInfo = { phoneNumber: null, queueName: null, queueRef: null };

function build(t: SourceTranscript, identity: IdentityInfo = NOBODY, raw: Record<string, unknown> = {}) {
  return buildNormalizedConversation(t, identity, "synthetic_source", raw, RECEIVER);
}

const ctr = (extra: Partial<CtrRecord> = {}): CtrRecord => ({
  ContactId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  CustomerEndpoint: { Address: "+12025550142", Type: "TELEPHONE_NUMBER" },
  Queue: { Name: "Support", Arn: "synthetic_queue_ref" },
  ...extra,
});

// Times

test("1 connect voice: start and end are seconds from the offsets, and the call start comes from the CTR", () => {
  const t = mapToSourceTranscript(voice, { s3Key: VOICE_KEY });
  const out = build(t, mapToIdentityInfo(ctr({ InitiationTimestamp: "2026-09-14T12:00:00.000Z", DisconnectTimestamp: "2026-09-14T12:01:30.000Z" })));
  assert.deepEqual(out.conversation.map((x) => [x.start, x.end]), [[0.5, 3.2], [3.4, 6.1], [6.3, 9]]);
  assert.equal(out.call_start_epoch, Date.parse("2026-09-14T12:00:00.000Z") / 1000);
  assert.equal(out.call_duration, 90);
});

test("1 connect voice without a CTR: offsets are still sent, the call start is left out, the duration is 0", () => {
  const out = build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }), mapToIdentityInfo(null));
  assert.equal(out.conversation[1].start, 3.4);
  assert.equal("call_start_epoch" in out, false);
  assert.equal(out.call_duration, 0);
});

test("1 connect chat: start is seconds since the first message, end equals start, the call start is the first message time", () => {
  for (const file of [chat1, chat2]) {
    const t = mapToSourceTranscript(file);
    const out = build(t, mapToIdentityInfo(null));
    const firstAt = Date.parse(t.turns.find((x) => x.at)!.at!) / 1000;
    assert.equal(out.call_start_epoch, firstAt);
    for (const sent of out.conversation) {
      const expected = Math.round((Date.parse(sent.at!) / 1000 - firstAt) * 1000) / 1000;
      assert.equal(sent.start, expected);
      assert.equal(sent.end, sent.start);
      assert.equal(sent.startMs, null, "the fields sent before are unchanged");
    }
    assert.ok(out.conversation.some((x) => x.start > 0));
  }
});

test("1 genesys: start and end come from the first and last word, and there is no call start", () => {
  const t = mapGenesys("conv-synthetic-1", genesysDoc, null, logger);
  const out = build(t);
  assert.deepEqual(out.conversation.map((x) => [x.start, x.end]), [[0.5, 3.2], [3.4, 6.1]]);
  assert.equal("call_start_epoch" in out, false);
  assert.equal(out.call_direction, "inbound");
});

test("a turn with no offset and no clock time starts at 0, and an unknown end equals the start", () => {
  const t: SourceTranscript = {
    sourceContactId: "x", sourceInstanceId: null, channel: "VOICE", sentimentOverall: null, matchedCategories: [], summary: null,
    turns: [
      { speaker: "agent", text: "a", startMs: null, endMs: null, sentiment: null },
      { speaker: "customer", text: "b", startMs: 2500, endMs: null, sentiment: null },
    ],
  };
  assert.deepEqual(build(t).conversation.map((x) => [x.start, x.end]), [[0, 0], [2.5, 2.5]]);
});

test("call direction comes from the CTR only when it says which way the contact went", () => {
  const dir = (method?: string) => mapToIdentityInfo(ctr({ InitiationMethod: method })).callDirection ?? null;
  assert.equal(dir("OUTBOUND"), "outbound");
  assert.equal(dir("INBOUND"), "inbound");
  assert.equal(dir("TRANSFER"), null);
  assert.equal(dir(undefined), null);
  const t = mapToSourceTranscript(voice, { s3Key: VOICE_KEY });
  assert.equal(build(t, mapToIdentityInfo(ctr({ InitiationMethod: "OUTBOUND" }))).call_direction, "outbound");
  assert.equal(build(t, mapToIdentityInfo(ctr({ InitiationMethod: "TRANSFER" }))).call_direction, "inbound");
});

// Turn source

test("2 a human agent and a customer are marked as speech to text turns, for each source", () => {
  const sets = [
    build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY })),
    build(mapToSourceTranscript(chat1)),
    build(mapGenesys("conv-synthetic-1", genesysDoc, null, logger)),
  ];
  for (const out of sets) {
    assert.ok(out.conversation.length > 0);
    assert.ok(out.conversation.every((x) => x.source === "stt"));
    assert.ok(out.conversation.every((x) => x.language === "en" && x.cut_off === false && x.text_known === true));
  }
});

test("2 an automated speaker is marked as an AI agent turn, the same marking the ElevenLabs adapter uses", () => {
  const t: SourceTranscript = {
    sourceContactId: "x", sourceInstanceId: null, channel: "CHAT", sentimentOverall: null, matchedCategories: [], summary: null,
    turns: [
      { speaker: "agent", text: "I am the assistant.", startMs: 0, endMs: 1000, sentiment: null, automated: true },
      { speaker: "agent", text: "I am a person.", startMs: 1000, endMs: 2000, sentiment: null },
    ],
  };
  const out = build(t);
  assert.deepEqual(out.conversation.map((x) => x.source), ["llm", "stt"]);
  const el = mapToCallRequest(
    { conversation_id: "c", agent_id: "a", transcript: [{ role: "agent", message: "hello", time_in_call_secs: 0 }] },
    { wabaId: "b", wabaPhone: "+12025550111" },
    { customerPhoneVariable: "customer_phone" },
  );
  assert.equal(el.payload.conversation[0].source, out.conversation[0].source);
});

test("2 connect flow messages and the Genesys automated roles are still left out and counted, not sent", () => {
  const t = mapToSourceTranscript(chat1);
  const out = build(t);
  assert.equal(out.skipped_turns, 3);
  assert.equal(out.conversation.length + out.skipped_turns, t.turns.length);
  const doc = { transcripts: [
    { participant: { purpose: "ivr" }, alternatives: [{ transcript: "Press one.", words: [] }] },
    { participant: { purpose: "customer" }, alternatives: [{ transcript: "One.", words: [] }] },
  ] };
  const g = build(mapGenesys("conv-synthetic-2", doc, null, logger));
  assert.equal(g.conversation.length, 1);
  assert.equal(g.skipped_turns, 1);
});

// Customer number

test("3 no customer number sends anonymous, for each source, and the conversation is not skipped", () => {
  for (const out of [
    build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }), mapToIdentityInfo(null)),
    build(mapToSourceTranscript(chat2), mapToIdentityInfo(null)),
    build(mapGenesys("conv-synthetic-1", genesysDoc, null, logger)),
  ]) {
    assert.equal(out.customer_phone, "anonymous");
    assert.equal(out.raw.customerPhoneSource, "none");
    assert.equal(out.raw.customerPhoneCandidateRejected, false);
    assert.ok(out.conversation.length > 0);
  }
});

test("a usable number from the CTR is kept and recorded", () => {
  const out = build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }), mapToIdentityInfo(ctr()));
  assert.equal(out.customer_phone, "+12025550142");
  assert.equal(out.raw.customerPhoneSource, "contact_trace_record");
  const spaced = build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }), mapToIdentityInfo(ctr({ CustomerEndpoint: { Address: "+1 202 555 0142" } })));
  assert.equal(spaced.customer_phone, "+12025550142");
});

test("4 a number outside 8 to 15 digits is refused and recorded in raw, for each source", () => {
  for (const address of ["+1202555", "+120255501421234567", "not a number"]) {
    const out = build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }), mapToIdentityInfo(ctr({ CustomerEndpoint: { Address: address } })));
    assert.equal(out.customer_phone, "anonymous", address);
    assert.equal(out.raw.customerPhoneCandidateRejected, true, address);
    assert.equal(out.raw.customerPhoneSource, "none", address);
    assert.ok(!JSON.stringify(out.raw).includes(address), "the refused value is not copied into raw");
  }
  const g = build(mapGenesys("conv-synthetic-1", genesysDoc, null, logger), { ...NOBODY, phoneNumber: "12345" });
  assert.equal(g.customer_phone, "anonymous");
  assert.equal(g.raw.customerPhoneCandidateRejected, true);
});

test("the shared number helpers keep the 8 to 15 digit bounds", () => {
  assert.equal(usablePhone("+1234567"), null);
  assert.equal(usablePhone("+12345678"), "+12345678");
  assert.equal(usablePhone("+123456789012345"), "+123456789012345");
  assert.equal(usablePhone("+1234567890123456"), null);
  assert.equal(usablePhone(12345678), null);
  assert.deepEqual(resolveCustomerPhone("", "x"), { phone: "anonymous", source: "none", rejectedCandidate: false });
  assert.equal(toEpochSeconds("not a date"), null);
});

// What was sent before is still sent

test("5 every field sent before this change is still present and unchanged", () => {
  const t = mapToSourceTranscript(chat1);
  const out = build(t, mapToIdentityInfo(ctr()), { analysisS3Bucket: "synthetic-bucket", analysisS3Key: "synthetic-key" });
  const before = ["schemaVersion", "source", "channel", "call_uuid", "instance_id", "captured_at", "customer_phone", "customer_context", "waba_id", "waba_phone", "country_code", "conversation", "skipped_turns", "sentiment_overall", "matched_categories", "summary", "queue", "raw"];
  for (const key of before) assert.ok(key in out, key);
  assert.equal(out.schemaVersion, "2.0");
  assert.equal(out.source, "synthetic_source");
  assert.equal(out.channel, "CHAT");
  assert.equal(out.call_uuid, t.sourceContactId);
  assert.equal(out.instance_id, t.sourceInstanceId);
  assert.equal(out.customer_phone, "+12025550142");
  assert.deepEqual(out.customer_context, { customer_name: null });
  assert.deepEqual([out.waba_id, out.waba_phone, out.country_code], ["synthetic_business_001", "+12025550111", "1"]);
  assert.deepEqual(out.sentiment_overall, t.sentimentOverall);
  assert.deepEqual(out.matched_categories, t.matchedCategories);
  assert.equal(out.summary, t.summary);
  assert.deepEqual(out.queue, { name: "Support", ref: "synthetic_queue_ref" });
  assert.equal(out.raw.analysisS3Bucket, "synthetic-bucket");
  assert.equal(out.raw.analysisS3Key, "synthetic-key");
  const sent = t.turns.filter((x) => x.speaker === "agent" || x.speaker === "customer");
  assert.equal(out.conversation.length, sent.length);
  out.conversation.forEach((turn, i) => {
    assert.equal(turn.speaker, sent[i].speaker);
    assert.equal(turn.text, sent[i].text);
    assert.equal(turn.startMs, sent[i].startMs);
    assert.equal(turn.endMs, sent[i].endMs);
    assert.equal(turn.at, sent[i].at ?? null);
    assert.equal(turn.sentiment, sent[i].sentiment);
  });
});

test("the added top level fields are the ones the receiver reads, with the defaults the ElevenLabs adapter uses", () => {
  const out = build(mapToSourceTranscript(voice, { s3Key: VOICE_KEY }));
  assert.deepEqual(
    [out.call_direction, out.call_duration, out.agent_extension, out.company_id, out.recording_filename, out.widget_source, out.widget_token, out.referring_domain],
    ["inbound", 0, "", "", null, "", "", ""],
  );
  const el = mapToCallRequest(
    { conversation_id: "c", agent_id: "a", transcript: [{ role: "user", message: "hi", time_in_call_secs: 0 }] },
    { wabaId: "b", wabaPhone: "+12025550111" },
    { customerPhoneVariable: "customer_phone" },
  ).payload;
  for (const key of ["call_direction", "call_duration", "agent_extension", "company_id", "recording_filename", "widget_source", "widget_token", "referring_domain"] as const) {
    assert.deepEqual(out[key], el[key], key);
  }
  assert.deepEqual(Object.keys(out.conversation[0]).filter((k) => Object.keys(el.conversation[0]).includes(k)).sort(), Object.keys(el.conversation[0]).sort());
});

// The route

test("the Amazon Connect route forwards the added fields, and still answers before the receiver finishes", async () => {
  const received: any[] = [];
  const rx = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      setTimeout(() => { res.writeHead(200); res.end("{}"); }, 500);
    });
  });
  await new Promise<void>((r) => rx.listen(0, r));
  const config = loadConfig({
    INBOUND_API_KEY: "k".repeat(24),
    OUTBOUND_WEBHOOK_URL: `http://127.0.0.1:${(rx.address() as AddressInfo).port}/receive`,
    OUTBOUND_WEBHOOK_SECRET: "o".repeat(24),
    AMAZON_CONNECT_DEMO_MODE: "true",
  });
  const server = http.createServer(buildServer({ config, s3: createS3Client(config), logger }));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/webhook/amazon-connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "k".repeat(24) },
      body: JSON.stringify({ "detail-type": "Object Created", source: "aws.s3", detail: { bucket: { name: "b" }, object: { key: VOICE_KEY } } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: true });
    assert.ok(Date.now() - started < 400, "the early reply is unchanged");
    const start = Date.now();
    while (received.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 25));
    const body = received[0];
    assert.equal(body.customer_phone, "anonymous");
    assert.equal(body.call_direction, "inbound");
    assert.deepEqual(body.conversation.map((x: any) => [x.start, x.end, x.source]), [[0.5, 3.2, "stt"], [3.4, 6.1, "stt"], [6.3, 9, "stt"]]);
    assert.equal(body.schemaVersion, "2.0");
    await new Promise((r) => setTimeout(r, 700)); // let the receiver answer, so nothing is cut off
  } finally {
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    await new Promise<void>((r) => { rx.closeAllConnections?.(); rx.close(() => r()); });
  }
});
