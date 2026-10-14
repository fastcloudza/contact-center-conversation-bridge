import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { IdentityInfo, NormalizedConversation, OutputTurn, SourceTranscript } from "./types.js";
import { forwardToWebhook } from "./webhook.js";

/**
 * The one function every adapter converges on. Takes whatever it managed to
 * fetch and map from its vendor, stitches in identity, and forwards it.
 * Nothing vendor-specific from here on.
 */
export interface ReceiverIdentifiers {
  businessId?: string | null;
  businessPhone?: string | null;
  countryCode?: string | null;
}

export function buildNormalizedConversation(
  transcript: SourceTranscript,
  identity: IdentityInfo,
  source: string,
  raw: Record<string, unknown>,
  receiver: ReceiverIdentifiers = {},
): NormalizedConversation {
  const conversation: OutputTurn[] = [];
  for (const t of transcript.turns) {
    if (t.speaker !== "agent" && t.speaker !== "customer") continue;
    conversation.push({
      speaker: t.speaker,
      text: t.text,
      startMs: t.startMs,
      endMs: t.endMs,
      at: t.at ?? null,
      sentiment: t.sentiment,
    });
  }
  return {
    schemaVersion: "2.0",
    source,
    channel: transcript.channel,
    call_uuid: transcript.sourceContactId,
    instance_id: transcript.sourceInstanceId,
    captured_at: new Date().toISOString(),
    customer_phone: identity.phoneNumber,
    customer_context: { customer_name: null },
    waba_id: receiver.businessId || null,
    waba_phone: receiver.businessPhone || null,
    country_code: receiver.countryCode || null,
    conversation,
    skipped_turns: transcript.turns.length - conversation.length,
    sentiment_overall: transcript.sentimentOverall,
    matched_categories: transcript.matchedCategories,
    summary: transcript.summary,
    queue: { name: identity.queueName, ref: identity.queueRef },
    raw,
  };
}

export async function ingestConversation(
  config: Config,
  logger: Logger,
  transcript: SourceTranscript,
  identity: IdentityInfo,
  source: string,
  raw: Record<string, unknown>,
): Promise<NormalizedConversation> {
  const normalized = buildNormalizedConversation(transcript, identity, source, raw, {
    businessId: config.RECEIVER_BUSINESS_ID,
    businessPhone: config.RECEIVER_BUSINESS_PHONE,
    countryCode: config.RECEIVER_COUNTRY_CODE,
  });
  await forwardToWebhook(config, normalized, logger);
  return normalized;
}
