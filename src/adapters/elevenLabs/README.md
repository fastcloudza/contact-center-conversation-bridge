# ElevenLabs adapter

Receives ElevenLabs' post call webhook, verifies it, and forwards the finished conversation.

## What is confirmed and what is not

Confirmed by running the tests in `test/elevenLabs.test.ts` on synthetic data:

- The route reads the raw body and verifies the signature with the official SDK (`@elevenlabs/elevenlabs-js`, version 2.79.0 when this was written). The tests sign with a secret made up for the test, so they prove the route and the SDK agree. They do not prove ElevenLabs' real signature.
- The mapping, the customer number rules, the replies for each event type, and the retry behaviour against a fake receiver.

Taken from ElevenLabs' public documentation and published SDK source, read on 16 November 2026, and not yet seen in a real delivery:

- The payload field names and shapes in `types.ts`.
- That a post call webhook carries the dynamic variables under `conversation_initiation_client_data.dynamic_variables`, including `system__caller_id`.
- The retry schedule and the 30 minute signature tolerance.

Not documented, so not assumed: which of `agent_number` and `external_number` is the customer, and what `system__caller_id` holds on an outbound call.

The first real payload from a test agent replaces the synthetic fixtures. Until then this source is built, not proven.

## How a delivery is handled

1. A request with no usable `ElevenLabs-Signature` header is refused with 401 before its body is read.
2. The body is read as raw bytes, up to `ELEVENLABS_MAX_BODY_MB`, and the SDK checks the signature and the timestamp. A failure is a 401.
3. Only `post_call_transcription` is forwarded. Audio, call initiation failures and unknown types are answered 200 and ignored. The log carries the event type and the conversation id only.
4. The agent id is looked up in the agent map. An unknown agent is answered 200 with a warning.
5. The conversation is mapped, then forwarded. 200 follows only after the receiver accepted it. A receiver 4xx is logged with the conversation id and the reason and answered 200. A receiver or network failure is answered 503.

The logs never carry transcript text or phone numbers.

## The request it sends

One request per conversation, in the form a receiver of finished calls expects:

| Field | Value |
|---|---|
| `call_uuid` | the ElevenLabs conversation id |
| `customer_phone` | a number from a field documented as the customer's, else `anonymous` |
| `waba_id`, `waba_phone`, `company_id`, `agent_extension` | from the agent map, empty strings when not set |
| `conversation[]` | `speaker`, `text`, `start` and `end` in seconds (`end` equals `start`, ElevenLabs gives no end), `language` `en`, `source` `llm` for the agent and `caller` for the customer, `cut_off` false, `text_known` true |
| `call_direction` | `outbound` when ElevenLabs says so, otherwise `inbound` |
| `call_duration` | `metadata.call_duration_secs`, or 0 |
| `call_start_epoch` | `metadata.start_time_unix_secs`, left out when absent |
| `recording_filename` | `null`, there is no audio |
| `raw` | the agent id, where the customer number came from, whether a candidate was refused, how many entries were skipped |

Customer number, in this order: the dynamic variable named by `ELEVENLABS_CUSTOMER_PHONE_VARIABLE`, `metadata.sms.sms_user_phone_number`, then `system__caller_id` when `metadata.phone_call.direction` is `inbound`. A value with fewer than 8 or more than 15 digits is refused. A leading zero becomes `+27`. The transcript is never searched.

## Timing and size

The longest the route can take is `ELEVENLABS_FORWARD_ATTEMPTS` times `OUTBOUND_WEBHOOK_TIMEOUT_MS` plus 500 ms between attempts. The defaults give 10.5 seconds. ElevenLabs does not document how long it waits for a transcription webhook reply.

The body limit defaults to 100 MiB because audio deliveries carry the whole recording and the signature needs the whole body. A request larger than the limit gets 413.
