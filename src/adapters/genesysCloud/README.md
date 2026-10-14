# Genesys Cloud adapter

Status: **fetch and mapping implemented, trigger left to you.** This is a
meaningfully different shape from Amazon Connect, worth understanding
before you wire it in.

## Why there's no route to mount

Amazon Connect pushes a notification the moment a Contact Lens analysis
file lands in S3, that's the whole reason `/webhook/amazon-connect` can
exist as a passive HTTP route. Genesys Cloud doesn't push to an arbitrary
webhook URL for this. You get two real options, both pull-based:

1. **Poll.** Genesys's Analytics Query API can tell you which conversations
   recently completed. Run this on a schedule, and for each newly-completed
   conversation, call the functions in `client.ts` to fetch its transcript.
   Simplest to build, adds latency equal to your poll interval.
2. **Subscribe via the Notifications API.** Genesys Cloud supports a
   pub/sub model where you create a Notification Channel and subscribe to
   topics, delivered over a **persistent WebSocket connection**, not a
   plain HTTP POST. The `v2.conversations.{id}.transcription` topic exists
   for this. Lower latency, but it's a different kind of process to run,
   a long-lived connection with reconnect handling, not a stateless
   request handler, and you need to already know the conversation ID to
   subscribe to its topic, which usually means combining it with another
   signal (a queue-level topic, or your own IVR/flow logic) to learn that a
   new conversation exists in the first place.

Neither of these is a small addition to `server.ts`, which is why this
adapter isn't mounted there. Building either one is a real, separate piece
of work, pick based on the latency you actually need.

## What's real here

- `client.ts`'s OAuth client-credentials flow and its two GET requests
  (conversation sentiment, transcript URL) are implemented against
  Genesys's published API documentation.
- The conversation sentiment response shape (`sentimentScore`,
  `sentimentTrend`) is confirmed directly from Genesys's docs.

## What's a documented guess, not a confirmed fact

- The exact JSON field the transcript URL comes back under (`client.ts`
  reads a few plausible names defensively and throws a clear error naming
  the actual keys it got back if none match).
- The internal structure of the downloaded transcript document itself
  (`types.ts`'s `GenesysTranscriptDocumentGuess`, and the traversal in
  `mapper.ts`'s `mapTranscriptDocumentToTurns`). Genesys documents what the
  transcript *contains* (words with confidence and timings, sentiment
  events, topic events), not the literal field names, and this couldn't be
  checked against a live tenant.

Run `fetch-and-ingest-example.ts` against a real conversation, it logs a
preview of the raw transcript document before mapping it, compare that
against `mapTranscriptDocumentToTurns()` and adjust the traversal to match
what you actually get back. If it doesn't match, you'll get zero turns and
a warning in the logs, not silently wrong data.
