import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { IdentityInfo, NormalizedConversation, OutputTurn, SourceTranscript, SourceTurn } from "./types.js";
import { resolveCustomerPhone, round3, toEpochSeconds } from "./contract.js";
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

/** Start and end in seconds for each turn, and the start of the conversation.
 *  A turn with offsets uses them. A turn with a clock time is placed relative to
 *  the first clock time. A turn with neither starts at 0. An unknown end equals
 *  the start. */
function deriveTimes(turns: SourceTurn[], identity: IdentityInfo) {
  let base: number | null = null;
  for (const t of turns) {
    if (t.startMs == null) {
      const at = toEpochSeconds(t.at);
      if (at !== null) {
        base = at;
        break;
      }
    }
  }
  const forTurn = (t: SourceTurn): { start: number; end: number } => {
    if (t.startMs != null) {
      const start = round3(t.startMs / 1000);
      return { start, end: t.endMs != null ? round3(t.endMs / 1000) : start };
    }
    const at = toEpochSeconds(t.at);
    if (at !== null && base !== null) {
      const start = round3(Math.max(0, at - base));
      return { start, end: start };
    }
    return { start: 0, end: 0 };
  };
  const callStart = base !== null ? round3(base) : identity.callStartEpoch ?? null;
  return { forTurn, callStart };
}

export function buildNormalizedConversation(
  transcript: SourceTranscript,
  identity: IdentityInfo,
  source: string,
  raw: Record<string, unknown>,
  receiver: ReceiverIdentifiers = {},
): NormalizedConversation {
  const times = deriveTimes(transcript.turns, identity);
  const conversation: OutputTurn[] = [];
  for (const t of transcript.turns) {
    if (t.speaker !== "agent" && t.speaker !== "customer") continue;
    const { start, end } = times.forTurn(t);
    conversation.push({
      speaker: t.speaker,
      text: t.text,
      startMs: t.startMs,
      endMs: t.endMs,
      at: t.at ?? null,
      sentiment: t.sentiment,
      start,
      end,
      language: "en",
      source: t.automated ? "llm" : "stt",
      cut_off: false,
      text_known: true,
    });
  }
  const phone = resolveCustomerPhone(identity.phoneNumber, identity.phoneSource);
  const normalized: NormalizedConversation = {
    schemaVersion: "2.0",
    source,
    channel: transcript.channel,
    call_uuid: transcript.sourceContactId,
    instance_id: transcript.sourceInstanceId,
    captured_at: new Date().toISOString(),
    customer_phone: phone.phone,
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
    raw: { ...raw, customerPhoneSource: phone.source, customerPhoneCandidateRejected: phone.rejectedCandidate },
    call_direction: identity.callDirection ?? "inbound",
    call_duration: identity.callDurationSecs ?? 0,
    agent_extension: "",
    company_id: "",
    recording_filename: null,
    widget_source: "",
    widget_token: "",
    referring_domain: "",
  };
  if (times.callStart !== null) normalized.call_start_epoch = times.callStart;
  return normalized;
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
