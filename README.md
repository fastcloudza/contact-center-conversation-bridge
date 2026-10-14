# contact-center-conversation-bridge

Takes a speaker-attributed transcript from a contact-center platform (agent,
customer, agent, customer), turns it into one plain, vendor-agnostic JSON shape,
and forwards it to a webhook you control.

## Why this exists

I run Wappari, a platform where every conversation a business has with a
customer ends up in one thread per customer, whatever channel it came in on.
Businesses that also run a contact center on Amazon Connect or Genesys have
their calls and chats locked inside that platform. Each vendor keeps the
transcript in its own shape, and links it to the customer only through a
contact id.

This bridge is the small piece in between. An adapter per platform reads the
vendor's transcript and turns it into the same agent and customer turns, and
one shared path forwards it to a webhook. What happens after that is up to the
receiver. In my case, Wappari adds it to the customer's existing conversation.

Arno Hart · [LinkedIn](https://www.linkedin.com/in/arnohart/)

Built with Claude Code. The problem, the design decisions and the testing
against a live Amazon Connect instance are mine.

## Supported sources

| Source | Status |
|---|---|
| Amazon Connect (Contact Lens) | Chat: supported. Voice and email: supported, following Amazon's documented output format. See [Amazon Connect output format](#amazon-connect-output-format) |
| Genesys Cloud (Speech and Text Analytics) | Fetch and mapping implemented against confirmed endpoints; the transcript document's internal field names are a documented best-effort guess, not verified against a live tenant; no trigger wired in, see `src/adapters/genesysCloud/README.md` |
| NICE Enlighten, Verint, CallMiner, Google Cloud CCAI, Microsoft Dynamics/Azure | Not implemented, see `docs/adding-a-source.md` |

## Amazon Connect output format

How the adapter reads Contact Lens analysis files.

**Chat:**
- Top level: `Version` "CHAT-2022-11-30", `Channel`, `JobStatus`, `LanguageCode`, `CustomerMetadata` with `ContactId` and `InstanceId`, `Participants`, `Transcript`, `Categories`, `ConversationCharacteristics`.
- Each transcript line carries `ParticipantId` and `ParticipantRole` (`CUSTOMER`, `AGENT`, `SYSTEM`). Lines of `Type` "EVENT" (joined, left, chat ended) are not speech and are skipped.
- Chat lines have `AbsoluteTime`, not millisecond offsets, so `startMs` and `endMs` are null and the turn's `at` field holds the clock time.
- Chat lines have no sentiment of their own. Sentiment is a separate list, `ConversationCharacteristics.Sentiment.DetailsByTranscriptItemGroup`, tied to lines by id. The mapper joins them.
- Categories and a contact summary appear only if the instance has them switched on. The sample files have neither.
- Where the files were found: at the top of the bucket under `Analysis/Chat/`, not under an instance folder. File name `<contactId>_analysis_<timestamp>.json`.
- The test data in `fixtures/amazon-connect/captured-chat-*.json` is from those files, with the account id, instance id, bucket name, instance alias and agent name replaced.

**Voice, email and redacted files (from Amazon's documentation):**
- Voice: one `Transcript` line per turn with `ParticipantId`; roles come from the top-level `Participants` array; times are `BeginOffsetMillis` and `EndOffsetMillis`; no `CustomerMetadata` block in the example, so the contact id is read from the S3 file name.
- Email: the example has no `Transcript`; the adapter returns zero turns for it.
- Redacted copies under `Redacted/`.

A speaker that cannot be determined is labelled `unknown`; it does not stop the conversation being processed.

## Architecture

```
Amazon Connect (Contact Lens)          Genesys Cloud (Speech & Text Analytics)
        │  pushes via EventBridge              │  pull: poll or subscribe
        ▼                                       ▼
POST /webhook/amazon-connect          your own trigger + client.ts's fetches
        │                                       │
        └───────────────┬───────────────────────┘
                         ▼
              adapter's mapper.ts
      (vendor shape -> SourceTranscript + IdentityInfo)
                         ▼
              ingestConversation()
        (shared, vendor-agnostic from here on)
                         ▼
         POST OUTBOUND_WEBHOOK_URL   (your system, HMAC-signed)
```

See [docs/eventbridge-setup.md](docs/eventbridge-setup.md) for the Amazon
Connect AWS-side wiring, and
[src/adapters/genesysCloud/README.md](src/adapters/genesysCloud/README.md)
for why Genesys Cloud's integration works differently, not just looks
different in the documentation.

## What it deliberately does not do

- **It does not resolve a business account, customer identity, or anything
  domain-specific.** No platform in this space has a concept of "which
  business owns this call" beyond its own tenant. That mapping only makes
  sense inside whatever system receives the webhook.
- **It does not force every vendor into the same trigger shape.** Amazon
  Connect pushes, Genesys Cloud you have to pull. The architecture reflects
  that; see `docs/adding-a-source.md`.
- **It does not ship confident-looking code against schemas nobody here has
  verified.** Where a vendor's exact field names couldn't be confirmed
  against real documentation or a real payload, that's stated plainly in
  the adapter's own README and in code comments, with graceful degradation
  rather than silent wrong output. See the Genesys Cloud adapter for what
  this looks like in practice.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env: set INBOUND_API_KEY, OUTBOUND_WEBHOOK_URL, OUTBOUND_WEBHOOK_SECRET,
# and the AMAZON_CONNECT_* variables for the sources you're using
npm run build
npm start
```

For local development with auto-reload: `npm run dev`.

Run the test suite: `npm test`.

## Try it without AWS

Three terminals, no AWS account, no real Contact Lens call:

```bash
# Terminal 1: the bridge itself, in demo mode
cp .env.example .env   # defaults already point at the demo receiver
# edit .env: set INBOUND_API_KEY and OUTBOUND_WEBHOOK_SECRET to anything 16+ chars
# set AMAZON_CONNECT_DEMO_MODE=true
npm install
npm run dev

# Terminal 2: a stand-in for "your system", verifies the signature and
# pretty-prints whatever it receives
npm run demo:receiver

# Terminal 3: fires a synthetic EventBridge event at the bridge, the same
# shape AWS would send, pointing at fixtures/amazon-connect/sample-analysis.json
npm run demo:replay
```

Terminal 2 should print the normalized conversation, agent/customer turns,
categories, sentiment, with a verified signature.

## Run it against a real bucket

This reads a real analysis file from S3 instead of the demo fixture. You need an IAM user with read access to the Connect bucket (`s3:GetObject` and `s3:ListBucket`) and its access key.

1. In `.env`, set `AMAZON_CONNECT_DEMO_MODE=false`, `AMAZON_CONNECT_AWS_REGION` to the region of the bucket, and the two `AMAZON_CONNECT_AWS_*` key settings.
2. Start the bridge (`npm run dev`) and the receiver (`npm run demo:receiver`).
3. Name a real file and replay an event for it. The key is the full S3 key of an analysis file, as shown in the S3 console:

```powershell
$env:REPLAY_BUCKET="<your connect bucket>"
$env:REPLAY_KEY="Analysis/Chat/2026/10/14/<contactId>_analysis_<time>.json"
npm run demo:replay
```

The bridge answers 200 right away, and the receiver prints the turns a moment later. If delivery still fails after three attempts, the bridge logs the S3 key; send it again with the replay script once the receiver is back. If another program already uses port 8080, set `PORT` in `.env` to a free port; the replay script reads it from there.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `INBOUND_API_KEY_HEADER` | no | `x-api-key` | Header name every push adapter checks |
| `INBOUND_API_KEY` | yes | | Shared secret for push-triggered adapters |
| `OUTBOUND_WEBHOOK_URL` | yes | | Where the normalized payload is POSTed |
| `OUTBOUND_WEBHOOK_SECRET` | yes | | Used to HMAC-sign the outbound payload |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS` | no | `5000` | |
| `RECEIVER_BUSINESS_ID` | no | none | Sent as `waba_id`. Wappari's identifier for the business's WhatsApp number. |
| `RECEIVER_BUSINESS_PHONE` | Required when sending to Wappari | none | Sent as `waba_phone`. The business display number, international format. |
| `RECEIVER_COUNTRY_CODE` | no | none | Sent as `country_code`. |
| `AMAZON_CONNECT_ENABLED` | no | `true` | On/off. Accepts `true`/`false`, `1`/`0`, `yes`/`no`, `y`/`n`, `on`/`off` (any case). Blank means the default; anything else stops startup with an error. Mounts `/webhook/amazon-connect` |
| `AMAZON_CONNECT_DEMO_MODE` | no | `false` | Same accepted values as above. See [Try it without AWS](#try-it-without-aws) |
| `AMAZON_CONNECT_AWS_REGION` | no | `us-east-1` | |
| `AMAZON_CONNECT_AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | no | | Omit to use the SDK's default credential chain |
| `AMAZON_CONNECT_ANALYSIS_PATH_PREFIX` | no | `Analysis/Voice/,Analysis/Chat/` | Only S3 keys that START WITH one of these prefixes (separated by commas) are processed. In the one bucket checked, the files were at the top of the bucket. If yours sit under a folder, include it. Redacted copies live under `.../Redacted/` and also match, so with redaction on, each call can arrive twice |
| `AMAZON_CONNECT_CTR_RESOLVER` | no | `none` | `none` \| `s3`, see [CTR enrichment](#ctr-enrichment-optional) |
| `AMAZON_CONNECT_CTR_S3_BUCKET` | if resolver is `s3` | | |
| `AMAZON_CONNECT_CTR_S3_PREFIX` | no | `ContactTraceRecords/` | |
| `GENESYS_LOGIN_BASE_URL` / `GENESYS_API_BASE_URL` / `GENESYS_CLIENT_ID` / `GENESYS_CLIENT_SECRET` | only for the example script | | Not wired into the server, see `src/adapters/genesysCloud/README.md` |

## CTR enrichment (optional, Amazon Connect only)

Contact Lens's analysis JSON does not say who was on the call. (Per the
documented examples, the voice file has no contact ID inside it either, so the
bridge reads it from the S3 file name; chat and email files carry
`CustomerMetadata.ContactId`.) The phone number and queue come from the Contact
Trace Record (CTR), joined by `ContactId`, enabled separately under your
Connect instance's **Data Streaming** settings.

`AMAZON_CONNECT_CTR_RESOLVER=s3` ships as a working example against a layout
where each CTR lands as its own object at
`${AMAZON_CONNECT_CTR_S3_PREFIX}${contactId}.json`. Raw Kinesis Data
Firehose delivery batches many contacts per file on a time interval, it does
not look like this by default, you'll likely need a small consumer of your
own (a Lambda on the Firehose stream) that re-writes each CTR as an
individual object at that path, or implement `CtrResolver`
(`src/adapters/amazonConnect/ctrResolver.ts`) against however your CTR data
actually lands.

If you don't need the phone number or queue at all, leave the default
`AMAZON_CONNECT_CTR_RESOLVER=none`, the normalized payload's
`customer_phone` and `queue` fields will just be `null`.

## Output shape

The values below are illustrative.

Every adapter, regardless of source, produces this. The field names for the customer, the business and the conversation (`customer_phone`, `waba_id`, `waba_phone`, `call_uuid`, `conversation`) follow the way Wappari receives a finished conversation. A receiver that wants different names only has to rename them. The field names are set in `src/ingest.ts` (where the output is built) and `src/types.ts` (its type).

```jsonc
{
  "schemaVersion": "2.0",
  "source": "amazon_connect_contact_lens",   // or "genesys_cloud_speech_text_analytics", etc.
  "channel": "VOICE",
  "call_uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",   // the source's contact id, use it as the duplicate key
  "instance_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "captured_at": "2026-09-14T12:00:00.000Z",
  "customer_phone": "+15551234567",          // null when the source cannot tell
  "customer_context": { "customer_name": null },
  "waba_id": "your-business-id",             // from RECEIVER_BUSINESS_ID
  "waba_phone": "+15550001111",              // from RECEIVER_BUSINESS_PHONE
  "country_code": "1",                       // from RECEIVER_COUNTRY_CODE
  "conversation": [
    { "speaker": "agent", "text": "Thanks for calling, how can I help you today?", "startMs": 500, "endMs": 3200, "at": null, "sentiment": "NEUTRAL" },
    { "speaker": "customer", "text": "I never received my refund from last week.", "startMs": 3400, "endMs": 6100, "at": null, "sentiment": "NEGATIVE" }
    // Chat turns have "startMs": null, "endMs": null and an "at" ISO timestamp instead
  ],
  "skipped_turns": 0,                        // automated or unattributed lines left out of "conversation"
  "sentiment_overall": { "OverallSentiment": { "AGENT": 1.2, "CUSTOMER": -1.8 } },
  "matched_categories": ["refund-request"],
  "summary": "Customer called about a missing refund from the previous week; agent opened an investigation.",
  "queue": { "name": "Support", "ref": "arn:aws:connect:..." },
  "raw": { "analysisS3Bucket": "your-connect-bucket", "analysisS3Key": "Analysis/Voice/..." }
}
```

Only agent and customer turns are in `conversation`, in order. `waba_id`, `waba_phone` and `country_code` are not in Amazon's files. They are the receiver's own identifiers for the business, set in `.env`.

## Connecting it to Wappari

Wappari needs the customer's phone number and the business identifiers below to place the turns in the right customer conversation. The bridge's output uses the same field names, so it fits without translation:

| Bridge field | What it is for |
|---|---|
| `customer_phone` | The customer's phone number, in international format. |
| `waba_id` | Wappari's identifier for the business's WhatsApp number. |
| `waba_phone` | The business's display number. Required when sending to Wappari. |
| `call_uuid` | The conversation's unique id, taken from the source's contact id. |
| `conversation[].speaker`, `.text` | Who spoke (`customer` or `agent`) and what was said, in order. |
| `country_code` | The country calling code for the customer's number. |

A real Amazon Connect chat was delivered to Wappari with these fields and appeared as its own thread inside the customer's existing conversation, customer turns on one side and agent turns on the business side. To use another receiver, keep the fields it needs and rename or drop the rest.

## Verifying the webhook signature

Every outbound request carries `X-Bridge-Signature: sha256=<hex>`, an
HMAC-SHA256 of the raw JSON body using `OUTBOUND_WEBHOOK_SECRET`:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isValid(rawBody, signatureHeader, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Adding a new source

See [docs/adding-a-source.md](docs/adding-a-source.md).

## Licence

MIT. See [LICENSE](LICENSE).
