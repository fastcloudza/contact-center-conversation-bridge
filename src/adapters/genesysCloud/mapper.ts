import type { NormalizedSpeaker, IdentityInfo, SourceTranscript, SourceTurn } from "../../types.js";
import type { GenesysConversationSentiment, GenesysTranscriptDocumentGuess } from "./types.js";
import type { Logger } from "../../logger.js";

/** Genesys's core Conversations API models each participant with a
 *  "purpose" field, this part is a stable, well-known piece of their
 *  schema (values include agent, customer, ivr, acd, voicemail, etc). */
function mapPurposeToSpeaker(purpose: string | undefined): NormalizedSpeaker {
  switch ((purpose ?? "").toLowerCase()) {
    case "agent":
      return "agent";
    case "customer":
      return "customer";
    case "ivr":
    case "acd":
    case "voicemail":
      return "system";
    default:
      return "unknown";
  }
}

/**
 * Best-effort mapping from the UNVERIFIED transcript document shape (see
 * types.ts). If the real payload doesn't match this structure, this
 * returns an empty turns array and logs loudly rather than throwing or
 * silently fabricating content, adjust the traversal here once you've
 * inspected a real transcript from your tenant.
 */
export function mapTranscriptDocumentToTurns(
  doc: unknown,
  logger: Logger,
): SourceTurn[] {
  const guess = doc as GenesysTranscriptDocumentGuess;

  if (!guess || !Array.isArray(guess.transcripts)) {
    logger.warn(
      "Genesys transcript document didn't match the expected shape, returning no turns. " +
        "Inspect the raw payload and update mapTranscriptDocumentToTurns().",
    );
    return [];
  }

  const turns: SourceTurn[] = [];
  for (const entry of guess.transcripts) {
    const speaker = mapPurposeToSpeaker(entry.participant?.purpose);
    const text = entry.alternatives?.[0]?.transcript;
    if (!text) continue;

    const words = entry.alternatives?.[0]?.words ?? [];
    const startMs = words[0]?.startTimeMs ?? null;
    const endMs = words[words.length - 1]?.endTimeMs ?? null;

    turns.push({ speaker, text, startMs, endMs, sentiment: null });
  }
  return turns;
}

export function mapToSourceTranscript(
  conversationId: string,
  transcriptDoc: unknown,
  sentiment: GenesysConversationSentiment | null,
  logger: Logger,
): SourceTranscript {
  return {
    sourceContactId: conversationId,
    sourceInstanceId: null, // Genesys Cloud doesn't have a direct equivalent, your org ID if you need one
    channel: "VOICE",
    turns: mapTranscriptDocumentToTurns(transcriptDoc, logger),
    sentimentOverall: sentiment ? { score: sentiment.sentimentScore, trend: sentiment.sentimentTrend } : null,
    matchedCategories: [], // topic/program matches live in a different endpoint, not wired up yet
    summary: null, // Genesys Cloud Copilot summaries are a separate API this adapter doesn't call yet
  };
}

/** Genesys Cloud has no CTR-equivalent join step, the conversation's own
 *  participant data carries the customer's address directly. Wire this up
 *  once you're pulling the conversation object itself (GET
 *  /api/v2/conversations/{conversationId}), not implemented here since it's
 *  a separate, also-unverified-by-us endpoint shape. */
export function mapToIdentityInfo(): IdentityInfo {
  return { phoneNumber: null, queueName: null, queueRef: null };
}
