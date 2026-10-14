/**
 * Vendor-agnostic types. Every adapter's whole job is to produce a
 * SourceTranscript and an IdentityInfo from whatever shape its vendor
 * actually hands back, nothing past this point knows or cares which vendor
 * that was.
 */

export type NormalizedSpeaker = "agent" | "customer" | "system" | "unknown";

/** One turn, already labeled by the adapter using OUR speaker vocabulary,
 *  not the vendor's. This is the seam: every adapter's mapping code lives
 *  on its own side of it, the shared pipeline never sees a vendor-specific
 *  role string like "AGENT" or a Genesys participant "purpose". */
export interface SourceTurn {
  speaker: NormalizedSpeaker;
  text: string;
  startMs: number | null;
  endMs: number | null;
  sentiment: string | null;
  /** ISO 8601 time of the turn when the source gives clock times instead of offsets (Amazon Connect chat). */
  at?: string | null;
}

/** What an adapter hands the shared pipeline after fetching and mapping a
 *  finished conversation, before identity (phone number, queue) is known. */
export interface SourceTranscript {
  sourceContactId: string;
  sourceInstanceId: string | null;
  channel: string;
  turns: SourceTurn[];
  sentimentOverall: unknown | null;
  matchedCategories: string[];
  summary: string | null;
}

/** Whatever an adapter could resolve about who was actually on the call.
 *  Every vendor keeps this somewhere different (a joined CTR for Amazon
 *  Connect, the conversation's participants for Genesys), it's the
 *  adapter's job to go get it, not the shared pipeline's. */
export interface IdentityInfo {
  phoneNumber: string | null;
  queueName: string | null;
  queueRef: string | null;
}

/** One turn in the output. Only agent and customer turns are sent. */
export interface OutputTurn {
  speaker: "agent" | "customer";
  text: string;
  startMs: number | null;
  endMs: number | null;
  /** ISO 8601 time, for sources that give clock times instead of offsets. */
  at: string | null;
  sentiment: string | null;
}

/** The one shape the bridge sends, whatever the source. The field names for
 *  who, where and which conversation follow the way Wappari receives a
 *  finished conversation, so it connects without translation. Any receiver can
 *  use the same fields, or ignore the ones it does not need. */
export interface NormalizedConversation {
  schemaVersion: "2.0";
  source: string; // e.g. "amazon_connect_contact_lens", "genesys_cloud_speech_text_analytics"
  channel: string;
  /** The source's contact id. Use it as the duplicate key. */
  call_uuid: string;
  instance_id: string | null;
  captured_at: string;
  /** International format, when the source can tell. */
  customer_phone: string | null;
  customer_context: { customer_name: string | null };
  /** The receiving side's identifier for the business, set in the bridge's settings. */
  waba_id: string | null;
  /** The business's display number, set in the bridge's settings. Needed to put business turns on the business side. */
  waba_phone: string | null;
  country_code: string | null;
  /** Ordered agent and customer turns. */
  conversation: OutputTurn[];
  /** Turns left out because they were neither agent nor customer, for example automated flow messages. */
  skipped_turns: number;
  sentiment_overall: unknown | null;
  matched_categories: string[];
  summary: string | null;
  queue: {
    name: string | null;
    ref: string | null;
  };
  raw: Record<string, unknown>;
}
