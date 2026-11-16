# Adding a new source

Any platform that produces a call, chat, or email transcript with agent and
customer attribution fits this pattern. NICE Enlighten, Verint, CallMiner,
Google Cloud CCAI, and Microsoft Dynamics/Azure aren't implemented, on
purpose, rather than shipped as unverified guesses against APIs nobody here
has tested against a live tenant. This is the contract to implement one.

## The two things every adapter produces

Regardless of how you get there, an adapter's whole job ends at two plain
objects, defined in `src/types.ts`:

```ts
interface SourceTranscript {
  sourceContactId: string;
  sourceInstanceId: string | null;
  channel: string;
  turns: SourceTurn[];       // speaker already mapped to "agent" | "customer" | "system" | "unknown"
  sentimentOverall: unknown | null;
  matchedCategories: string[];
  summary: string | null;
}

interface IdentityInfo {
  phoneNumber: string | null;
  queueName: string | null;
  queueRef: string | null;
}
```

Once you have both, call the one shared function every adapter converges
on:

```ts
import { ingestConversation } from "../../ingest.js";

await ingestConversation(config, logger, transcript, identity, "your_source_name", {
  /* whatever raw identifiers are worth keeping for debugging */
});
```

That's the entire contract. Everything upstream of it, how you learn a
conversation is ready, how you authenticate to the vendor, how you map
their speaker labels to ours, is vendor-specific and lives inside
your adapter's own folder.

## Two different trigger shapes, pick whichever your vendor actually is

**Push.** Your vendor calls you the moment something's ready (Amazon
Connect via EventBridge is the example). Build an Express router (see
`src/adapters/amazonConnect/router.ts`), mount it in `src/server.ts`, done.
This is the easy case.

**Push with the conversation in the body.** Some vendors push the whole finished
conversation in the request itself (ElevenLabs is the example, see
`src/adapters/elevenLabs/`). There is nothing to fetch, so there is no
`client.ts`. The router reads the body, checks who sent it, maps it and
forwards it. Three things differ from the event style push above:

1. The vendor signs the body, so the router needs the exact bytes. Mount it in
   `src/server.ts` before the JSON parser and give it its own raw body parser.
   The parser applies to that route only, the other routes are unchanged.
2. The vendor decides what a reply means. Answer 200 when retrying cannot help
   (a rejected delivery, an event you do not want) and 5xx only when a retry
   could succeed. Say in the adapter README how long the route can take.
3. The vendor may resend the same conversation. The bridge keeps no state, so
   say in the README that the receiver must use the conversation id as the
   duplicate key.

The mapped result does not have to be the normalized output. If the receiver
expects its own request shape, build that shape in the adapter's mapper and
hand it to `forwardToWebhook`, which accepts any object that has a `call_uuid`.

**Pull.** You have to ask the vendor, on a schedule or via a subscription
(Genesys Cloud is the example, see `src/adapters/genesysCloud/README.md`
for the two ways that can look). This means a separate long-running or
scheduled process, not a route. Don't force this shape into a fake webhook
route just for consistency, it'll misrepresent how the integration actually
behaves operationally.

## Checking who sent a request

The Amazon Connect route compares a static key in a header. That fits EventBridge,
which authenticates with a stored credential and does not sign payloads. Use it
when the vendor offers nothing better.

When the vendor signs the body, check the signature instead:

- Prefer the vendor's own library, and say in the adapter README which version
  was used.
- Verify against the raw bytes, never against a parsed and re-serialized body.
- Refuse a missing, wrong or stale signature with 401 and log only the reason.
- Reject an obviously unsigned request before the body is read, so an unsigned
  caller cannot make the route buffer a large body.
- Keep the secret in settings, never in the repository, and never log it.
- A test that signs with its own secret proves the route and the library agree.
  It does not prove the vendor's real signature. Name the test that way, and
  repeat the check with a real delivery when you have one.

## Steps

1. `mkdir src/adapters/yourVendor`
2. `types.ts`, the vendor's own JSON shapes, confirmed against their real
   docs or, better, a real payload from a real account. Don't guess field
   names with confidence you don't have, if a shape is uncertain, say so in
   a comment the way `genesysCloud/types.ts` does, and degrade gracefully
   in the mapper rather than asserting incorrect output.
3. `client.ts`, however you actually talk to the vendor, auth, the request
   that fetches a finished transcript. A source that pushes the conversation
   in the body skips this step.
4. `mapper.ts`, two functions: one turning the vendor's transcript into
   `SourceTranscript`, one turning whatever identity data you have into
   `IdentityInfo`.
5. Either `router.ts` (push) mounted in `server.ts`, or a documented,
   runnable example script showing the pull path end to end (pull), the
   way `fetch-and-ingest-example.ts` does for Genesys.
6. A README in your adapter's folder stating plainly what's confirmed
   against real documentation or a real payload, and what's a best-effort
   guess still needing verification. Copy-pasting a confident-sounding
   schema from a blog post is how this whole pipeline ends up quietly
   forwarding garbage, say what you actually know.
7. Add a fixture and a test under `test/`, following
   `test/amazonConnectMapper.test.ts`.
