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
their speaker labels to ours, is genuinely vendor-specific and lives inside
your adapter's own folder.

## Two different trigger shapes, pick whichever your vendor actually is

**Push.** Your vendor calls you the moment something's ready (Amazon
Connect via EventBridge is the example). Build an Express router (see
`src/adapters/amazonConnect/router.ts`), mount it in `src/server.ts`, done.
This is the easy case.

**Pull.** You have to ask the vendor, on a schedule or via a subscription
(Genesys Cloud is the example, see `src/adapters/genesysCloud/README.md`
for the two ways that can look). This means a separate long-running or
scheduled process, not a route. Don't force this shape into a fake webhook
route just for consistency, it'll misrepresent how the integration actually
behaves operationally.

## Steps

1. `mkdir src/adapters/yourVendor`
2. `types.ts`, the vendor's own JSON shapes, confirmed against their real
   docs or, better, a real payload from a real account. Don't guess field
   names with confidence you don't have, if a shape is uncertain, say so in
   a comment the way `genesysCloud/types.ts` does, and degrade gracefully
   in the mapper rather than asserting incorrect output.
3. `client.ts`, however you actually talk to the vendor, auth, the request
   that fetches a finished transcript.
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
