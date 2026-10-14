import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mapToSourceTranscript, mapToIdentityInfo, contactIdFromKey } from "../src/adapters/amazonConnect/mapper.js";
import { buildNormalizedConversation } from "../src/ingest.js";
import type { ContactLensAnalysisJson, CtrRecord } from "../src/adapters/amazonConnect/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): ContactLensAnalysisJson =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", "amazon-connect", name), "utf-8"));
const fixture = load("sample-analysis.json");
const chatFixture = load("sample-analysis-chat.json");
const captured1 = load("captured-chat-1.json");
const captured2 = load("captured-chat-2.json");
const VOICE_KEY =
  "Analysis/Voice/2026/09/14/a1b2c3d4-e5f6-7890-abcd-ef1234567890_analysis_2026-09-14T12:00:00Z.json";

test("maps AGENT/CUSTOMER turns to agent/customer speakers in order", () => {
  const transcript = mapToSourceTranscript(fixture, { s3Key: VOICE_KEY });

  assert.equal(transcript.turns.length, 3);
  assert.deepEqual(
    transcript.turns.map((t) => t.speaker),
    ["agent", "customer", "agent"],
  );
  assert.equal(transcript.turns[1].text, "I never received my refund from last week.");
  assert.equal(transcript.turns[1].sentiment, "NEGATIVE");
  assert.equal(transcript.turns[1].startMs, 3400);
});

test("carries contactId, instanceId, categories, and summary through", () => {
  const transcript = mapToSourceTranscript(fixture, { s3Key: VOICE_KEY });

  assert.equal(transcript.sourceContactId, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  assert.equal(transcript.sourceInstanceId, null, "the documented voice file has no instance id");
  assert.deepEqual(transcript.matchedCategories, ["refund-request"]);
  assert.match(transcript.summary ?? "", /missing refund/);
});

test("without a CTR record, customer phone number and queue are null", () => {
  const identity = mapToIdentityInfo(null);
  assert.equal(identity.phoneNumber, null);
  assert.equal(identity.queueName, null);
});

test("with a CTR record, customer phone number and queue are filled in", () => {
  const ctr: CtrRecord = {
    ContactId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    CustomerEndpoint: { Address: "+15551234567", Type: "TELEPHONE_NUMBER" },
    Queue: { Name: "Support", Arn: "arn:aws:connect:us-east-1:123456789012:instance/x/queue/y" },
  };
  const identity = mapToIdentityInfo(ctr);
  assert.equal(identity.phoneNumber, "+15551234567");
  assert.equal(identity.queueName, "Support");
});

test("buildNormalizedConversation stitches transcript + identity into the shared shape", () => {
  const transcript = mapToSourceTranscript(fixture, { s3Key: VOICE_KEY });
  const identity = mapToIdentityInfo(null);
  const normalized = buildNormalizedConversation(transcript, identity, "amazon_connect_contact_lens", {
    analysisS3Bucket: "test-bucket",
    analysisS3Key: "Analysis/Voice/test-key.json",
  });

  assert.equal(normalized.source, "amazon_connect_contact_lens");
  assert.equal(normalized.call_uuid, transcript.sourceContactId);
  assert.equal(normalized.conversation.length, 3);
  assert.equal(normalized.skipped_turns, 0);
  assert.equal(normalized.schemaVersion, "2.0");
  assert.equal(normalized.raw.analysisS3Bucket, "test-bucket");
});

test("documented voice shape: lines have ParticipantId only, role comes from Participants", () => {
  assert.ok(fixture.Transcript!.every((l) => l.ParticipantRole === undefined));
  const t = mapToSourceTranscript(fixture, { s3Key: VOICE_KEY });
  assert.deepEqual(t.turns.map((x) => x.speaker), ["agent", "customer", "agent"]);
});

test("Participants decides the role even when the id is not the role word", () => {
  const a: ContactLensAnalysisJson = {
    Participants: [
      { ParticipantId: "p-1", ParticipantRole: "CUSTOMER" },
      { ParticipantId: "p-2", ParticipantRole: "AGENT" },
    ],
    Transcript: [
      { ParticipantId: "p-2", Content: "hi" },
      { ParticipantId: "p-1", Content: "hello" },
    ],
  };
  const t = mapToSourceTranscript(a, { s3Key: VOICE_KEY });
  assert.deepEqual(t.turns.map((x) => x.speaker), ["agent", "customer"]);
});

test("a line whose speaker cannot be determined is 'unknown' and does not throw", () => {
  const cases: ContactLensAnalysisJson[] = [
    { Transcript: [{ Content: "no id at all" }] },
    { Transcript: [{ ParticipantId: "ghost", Content: "id not in Participants" }], Participants: [] },
    { Transcript: [{ ParticipantId: "x", Content: "no Participants array" }] },
    { Transcript: [{ ParticipantId: "x", ParticipantRole: "SOMETHING_NEW", Content: "odd role" }] },
  ];
  for (const a of cases) {
    const t = mapToSourceTranscript(a, { s3Key: VOICE_KEY });
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].speaker, "unknown");
  }
});

test("a line's own role wins over the lookup (chat shape)", () => {
  const t = mapToSourceTranscript(chatFixture);
  assert.deepEqual(t.turns.map((x) => x.speaker), ["agent"]);
});

test("chat: EVENT lines are not turns; no time offsets gives null times; CustomerMetadata is used", () => {
  const t = mapToSourceTranscript(chatFixture);
  assert.equal(t.turns.length, 1);
  assert.equal(t.turns[0].startMs, null);
  assert.equal(t.sourceContactId, "b49644f6-672f-445c-b209-f76b36482830");
  assert.equal(t.sourceInstanceId, "f23fc323-3d6d-48aa-95dc-EXAMPLE012");
  assert.equal(t.channel, "CHAT");
});

test("email-style file with no Transcript maps to zero turns without failing", () => {
  const t = mapToSourceTranscript({
    Channel: "EMAIL",
    CustomerMetadata: { ContactId: "c1", InstanceId: "i1" },
    Categories: { MatchedCategories: ["x"] },
  });
  assert.equal(t.turns.length, 0);
  assert.deepEqual(t.matchedCategories, ["x"]);
});

test("contact id falls back to the documented S3 file name", () => {
  assert.equal(contactIdFromKey(VOICE_KEY), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  assert.equal(
    contactIdFromKey("Analysis/Voice/Redacted/2026/09/14/abc_analysis_redacted_2026-09-14T12:00:00Z.json"),
    "abc",
  );
  assert.equal(contactIdFromKey("Analysis/Voice/whatever.json"), null);
});

test("no contact id anywhere gives a clear error, not an invented id", () => {
  assert.throws(() => mapToSourceTranscript({ Transcript: [] }), /Cannot determine the contact ID/);
});

// Fixtures captured-chat-1 and captured-chat-2 are real Contact Lens chat analysis
// files from a test chat (an Amazon Connect test instance), with the
// account id, instance id, bucket name, instance alias and agent name replaced.

test("real chat file: speakers come from the line role, system lines are 'system'", () => {
  const t = mapToSourceTranscript(captured1);
  assert.deepEqual(t.turns.map((x) => x.speaker), [
    "system", "system", "system", "customer", "agent", "customer", "agent", "customer", "agent", "customer", "agent",
  ]);
  assert.equal(t.turns[3].text, "Hello, my order never arrived and I am really frustrated.");
});

test("real chat file: join, leave and chat-ended events are not turns", () => {
  for (const f of [captured1, captured2]) {
    const t = mapToSourceTranscript(f);
    assert.ok(t.turns.every((x) => x.text.length > 0));
    assert.equal(t.turns.length, f.Transcript!.filter((l) => l.Type === "MESSAGE").length);
  }
});

test("real chat file: sentiment is taken from DetailsByTranscriptItemGroup by line id", () => {
  const t = mapToSourceTranscript(captured1);
  const bySpeaker = t.turns.filter((x) => x.speaker === "customer").map((x) => x.sentiment);
  assert.deepEqual(bySpeaker, ["NEGATIVE", "NEGATIVE", "NEUTRAL", "POSITIVE"]);
  assert.equal(t.turns.find((x) => x.speaker === "system")!.sentiment, null);
});

test("real chat file: times are clock times, not offsets", () => {
  const t = mapToSourceTranscript(captured2);
  assert.equal(t.turns[0].startMs, null);
  assert.match(t.turns[0].at ?? "", /^2026-10-14T12:13:09\.499Z$/);
});

test("real chat file: contact id, instance id and overall sentiment come through", () => {
  const t = mapToSourceTranscript(captured1);
  assert.equal(t.sourceContactId, "d5ad74f0-23b9-41c6-a6c0-d92643bee1e6");
  assert.equal(t.sourceInstanceId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(t.channel, "CHAT");
  assert.ok(t.sentimentOverall);
  assert.deepEqual(t.matchedCategories, []);
  assert.equal(t.summary, null);
});

test("real chat file without a chat-ended event still maps", () => {
  const t = mapToSourceTranscript(captured2);
  assert.equal(t.turns.filter((x) => x.speaker === "agent").length, 4);
});

test("output uses the receiver field names, sends only agent and customer turns, and copies the business identifiers", () => {
  const t = mapToSourceTranscript(captured1);
  const out = buildNormalizedConversation(t, mapToIdentityInfo(null), "amazon_connect_contact_lens", {}, {
    businessId: "BIZ1",
    businessPhone: "+15550001111",
    countryCode: "1",
  });
  assert.equal(out.waba_id, "BIZ1");
  assert.equal(out.waba_phone, "+15550001111");
  assert.equal(out.country_code, "1");
  assert.ok(out.conversation.every((x) => x.speaker === "agent" || x.speaker === "customer"));
  assert.equal(out.conversation.length + out.skipped_turns, t.turns.length);
  assert.ok(out.skipped_turns > 0, "the automated flow messages are counted, not sent");
  assert.deepEqual(out.conversation.map((x) => x.speaker).slice(0, 2), ["customer", "agent"]);
});
