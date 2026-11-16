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
  /** True when the vendor says an automated speaker produced the turn. The turn is then marked as an AI turn. */
  automated?: boolean;
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
  /** Where the number came from, recorded in raw. */
  phoneSource?: string | null;
  /** Set only when the source says which way the contact went. */
  callDirection?: "inbound" | "outbound" | null;
  /** Epoch seconds of the contact start, when the source knows it and the transcript has no clock times. */
  callStartEpoch?: number | null;
  /** Whole seconds, when the source knows it. */
  callDurationSecs?: number | null;
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
  /** Seconds from the start of the conversation. Derived from startMs, or from at when the source gives clock times. */
  start: number;
  /** Seconds. Equals start when the source gives no end. */
  end: number;
  language: string;
  /** "stt" for a person, "llm" for an automated speaker. */
  source: string;
  cut_off: boolean;
  text_known: boolean;
}

/** The one shape the bridge sends for Amazon Connect and Genesys Cloud. It
 *  carries the bridge's own fields and the fields a receiver of finished calls
 *  reads, under the names such a receiver uses: the customer, the business, the
 *  conversation id, and per turn start, end, language and source. A receiver
 *  can use the fields it needs and ignore the rest. */
export interface NormalizedConversation {
  schemaVersion: "2.0";
  source: string; // e.g. "amazon_connect_contact_lens", "genesys_cloud_speech_text_analytics"
  channel: string;
  /** The source's contact id. Use it as the duplicate key. */
  call_uuid: string;
  instance_id: string | null;
  captured_at: string;
  /** International format, or the literal "anonymous" when the source cannot tell. */
  customer_phone: string;
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
  /** Which way the contact went. "inbound" when the source does not say. */
  call_direction: string;
  /** Whole seconds, 0 when the source does not say. */
  call_duration: number;
  /** Epoch seconds of the start of the conversation. Left out when unknown. */
  call_start_epoch?: number;
  /** Not known to this bridge, sent as an empty string. */
  agent_extension: string;
  /** Not known to this bridge, sent as an empty string. */
  company_id: string;
  /** There is no recording to point at. */
  recording_filename: string | null;
  widget_source: string;
  widget_token: string;
  referring_domain: string;
}
