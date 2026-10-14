/**
 * Genesys Cloud specific shapes. Two confidence levels in here, marked
 * inline: the OAuth flow and the conversation-level sentiment endpoint are
 * confirmed against Genesys's published API docs. The transcript document's
 * internal structure is NOT independently verified against a live tenant,
 * see mapper.ts before trusting it.
 */

export interface GenesysTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Confirmed shape: GET /api/v2/speechandtextanalytics/conversations/{conversationId} */
export interface GenesysConversationSentiment {
  conversation: { id: string; selfUri?: string };
  sentimentScore: number;
  sentimentTrend: number;
  [key: string]: unknown; // the doc mentions empathy scores and participant metrics too, not modeled here yet
}

/**
 * UNVERIFIED. The transcript document downloaded from the URL returned by
 * GET .../communications/{communicationId}/transcripturl is documented by
 * Genesys as containing "words with confidence and timings, sentiment
 * events, topic events, and conversation/communication metadata", but the
 * exact field names below are a best-effort guess at a structure
 * consistent with that description, not a confirmed schema. Fetch one real
 * transcript from your own tenant and adjust this type (and mapper.ts)
 * before trusting output from it.
 */
export interface GenesysTranscriptDocumentGuess {
  transcripts?: Array<{
    channel?: string;
    participant?: { purpose?: string; userId?: string };
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: Array<{ word?: string; startTimeMs?: number; endTimeMs?: number }>;
    }>;
  }>;
  analytics?: {
    sentiment?: unknown;
    topics?: unknown;
  };
}
