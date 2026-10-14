import type { NormalizedSpeaker, IdentityInfo, SourceTranscript, SourceTurn } from "../../types.js";
import type { ContactLensAnalysisJson, CtrRecord } from "./types.js";

function mapRole(role: string | undefined): NormalizedSpeaker {
  switch ((role ?? "").trim().toUpperCase()) {
    case "AGENT":
      return "agent";
    case "CUSTOMER":
      return "customer";
    case "SYSTEM":
      return "system";
    default:
      return "unknown";
  }
}

/**
 * Contact Lens documents (voice) a top-level Participants array that maps
 * ParticipantId -> ParticipantRole, with each transcript line carrying only
 * ParticipantId. Chat lines carry the role themselves. We use the line's own
 * role when present, else look the id up in Participants, else "unknown".
 * Never throws: a line we cannot attribute is labelled "unknown".
 */
function buildRoleLookup(analysis: ContactLensAnalysisJson): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const p of analysis.Participants ?? []) {
    if (p && typeof p.ParticipantId === "string" && typeof p.ParticipantRole === "string") {
      lookup.set(p.ParticipantId, p.ParticipantRole);
    }
  }
  return lookup;
}

/**
 * Documented S3 file name: "<contactId>_analysis_<timestamp>.json" (and
 * "..._analysis_redacted_..." for redacted files), docs page
 * example-contact-lens-output-locations. Used only as a fallback when the
 * file has no CustomerMetadata (the documented voice example has none).
 */
export function contactIdFromKey(key: string): string | null {
  const file = key.split("/").pop() ?? "";
  const m = /^(.+?)_analysis_/.exec(file);
  return m ? m[1] : null;
}

/**
 * Chat files (seen in real output) carry no per-line Sentiment. Sentiment is a
 * separate list, ConversationCharacteristics.Sentiment.DetailsByTranscriptItemGroup,
 * whose entries name transcript line ids. Build id -> label from it.
 */
function buildSentimentLookup(analysis: ContactLensAnalysisJson): Map<string, string> {
  const lookup = new Map<string, string>();
  const groups = analysis.ConversationCharacteristics?.Sentiment?.DetailsByTranscriptItemGroup;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (typeof g?.Sentiment !== "string") continue;
    for (const t of g.TranscriptItems ?? []) {
      if (typeof t?.Id === "string") lookup.set(t.Id, g.Sentiment);
    }
  }
  return lookup;
}

export interface MapHints {
  /** The S3 key the file came from, used for the contact ID fallback. */
  s3Key?: string;
}

/** Resolves the contact ID: file's CustomerMetadata first, then the S3 file name. */
export function resolveContactId(analysis: ContactLensAnalysisJson, hints: MapHints = {}): string {
  const id =
    analysis.CustomerMetadata?.ContactId ?? (hints.s3Key ? contactIdFromKey(hints.s3Key) : null);
  if (!id) {
    throw new Error(
      "Cannot determine the contact ID: the file has no CustomerMetadata.ContactId and the S3 key does not match <contactId>_analysis_*.json",
    );
  }
  return id;
}

/** Amazon Connect's own analysis JSON + an optional CTR join -> the generic
 *  shape everything past this point actually works with. */
export function mapToSourceTranscript(
  analysis: ContactLensAnalysisJson,
  hints: MapHints = {},
): SourceTranscript {
  const roles = buildRoleLookup(analysis);
  const sentiments = buildSentimentLookup(analysis);

  const turns: SourceTurn[] = (analysis.Transcript ?? [])
    // Chat transcripts include join/leave events; they are not speech.
    .filter((item) => (item.Type === undefined || item.Type === "MESSAGE") && typeof item.Content === "string")
    .map((item) => {
      const role = item.ParticipantRole ?? (item.ParticipantId ? roles.get(item.ParticipantId) : undefined);
      return {
        speaker: mapRole(role),
        text: item.Content as string,
        startMs: item.BeginOffsetMillis ?? null,
        endMs: item.EndOffsetMillis ?? null,
        sentiment: item.Sentiment ?? (item.Id ? sentiments.get(item.Id) : undefined) ?? null,
        at: item.AbsoluteTime ?? null,
      };
    });

  return {
    sourceContactId: resolveContactId(analysis, hints),
    sourceInstanceId: analysis.CustomerMetadata?.InstanceId ?? null,
    channel: analysis.Channel ?? "VOICE",
    turns,
    sentimentOverall: analysis.ConversationCharacteristics?.Sentiment ?? null,
    matchedCategories: analysis.Categories?.MatchedCategories ?? [],
    summary: analysis.ConversationCharacteristics?.ContactSummary?.PostContactSummary?.Content ?? null,
  };
}

export function mapToIdentityInfo(ctr: CtrRecord | null): IdentityInfo {
  return {
    phoneNumber: ctr?.CustomerEndpoint?.Address ?? null,
    queueName: ctr?.Queue?.Name ?? null,
    queueRef: ctr?.Queue?.Arn ?? null,
  };
}
