/** Amazon Connect / Contact Lens specific shapes. Nothing outside this
 *  folder should ever import these, that's what makes the rest of the
 *  tool vendor-agnostic. */

/**
 * Source of these shapes: Amazon's published example output pages (opened
 * 10 Oct 2026), NOT a real Contact Lens file. Voice: contact-lens-example-output-files.
 * Chat: contact-lens-example-output-files-chat. Email: contact-lens-example-output-files-email.
 *
 * Documented differences that matter here:
 *  Voice: lines carry ParticipantId only. The role lives in the top-level
 *    Participants array. In the voice example the id and role happen to be
 *    the same word ("AGENT"), but that is an example, not a rule.
 *  Chat: lines carry both ParticipantId and ParticipantRole, and also
 *    include non-message lines (Type "EVENT") and a SYSTEM role.
 *  Chat: lines have AbsoluteTime (ISO timestamp), not millisecond offsets.
 *  Metadata: the voice example has no CustomerMetadata block; chat and email do.
 *  Email: the example has no Transcript at all.
 * Every field below is therefore optional except where the code cannot work
 * without it.
 */
export interface ContactLensParticipant {
  ParticipantId: string;
  ParticipantRole?: string;
}

export interface ContactLensSentimentGroup {
  ParticipantRole?: string;
  Sentiment?: string;
  ProgressiveScore?: number;
  TranscriptItems?: { Id?: string }[];
}

export interface ContactLensTranscriptItem {
  Id?: string;
  ParticipantId?: string;
  /** Present on chat lines per the docs. Not present on voice lines. */
  ParticipantRole?: string;
  /** Chat only: "MESSAGE" or "EVENT". Absent on voice lines. */
  Type?: string;
  Content?: string;
  BeginOffsetMillis?: number;
  EndOffsetMillis?: number;
  /** Chat only. ISO 8601 UTC. */
  AbsoluteTime?: string;
  Sentiment?: string;
}

export interface ContactLensAnalysisJson {
  Version?: string;
  AccountId?: string;
  Channel?: "VOICE" | "CHAT" | "EMAIL" | string;
  /** Documented for chat and email, absent from the documented voice example. */
  CustomerMetadata?: {
    ContactId?: string;
    InstanceId?: string;
    InputS3Uri?: string;
    InputFiles?: Record<string, string>;
  };
  Participants?: ContactLensParticipant[];
  Transcript?: ContactLensTranscriptItem[];
  Categories?: {
    MatchedCategories?: string[];
  };
  ConversationCharacteristics?: {
    /** Documented and seen in real chat files: overall scores plus a per-group
     *  list that ties a sentiment label to transcript line ids. */
    Sentiment?: {
      OverallSentiment?: unknown;
      DetailsByTranscriptItemGroup?: ContactLensSentimentGroup[];
      [key: string]: unknown;
    };
    TalkTime?: unknown;
    ContactSummary?: {
      PostContactSummary?: {
        Content?: string;
      };
    };
  };
}

/** What we can recover from a Contact Trace Record, joined by ContactId. */
export interface CtrRecord {
  ContactId: string;
  CustomerEndpoint?: { Address?: string; Type?: string };
  Agent?: { Username?: string; ARN?: string };
  Queue?: { Name?: string; Arn?: string };
  InitiationMethod?: string;
  InitiationTimestamp?: string;
  DisconnectTimestamp?: string;
}
