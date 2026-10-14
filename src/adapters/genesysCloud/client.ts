import type { GenesysConversationSentiment, GenesysTokenResponse } from "./types.js";

export interface GenesysCloudCredentials {
  /** e.g. "https://login.mypurecloud.com" or your region's login domain. */
  loginBaseUrl: string;
  /** e.g. "https://api.mypurecloud.com" or your region's API domain. */
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Standard OAuth2 client-credentials flow, this part is straightforward
 * and well-documented, not the uncertain part of this adapter.
 */
export async function fetchAccessToken(creds: GenesysCloudCredentials): Promise<string> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetch(`${creds.loginBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Genesys OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as GenesysTokenResponse;
  return data.access_token;
}

/** Confirmed endpoint and response shape (see types.ts). */
export async function fetchConversationSentiment(
  creds: GenesysCloudCredentials,
  accessToken: string,
  conversationId: string,
): Promise<GenesysConversationSentiment> {
  const res = await fetch(
    `${creds.apiBaseUrl}/api/v2/speechandtextanalytics/conversations/${conversationId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Genesys conversation sentiment request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GenesysConversationSentiment;
}

/**
 * Confirmed endpoint: GET .../communications/{communicationId}/transcripturl
 * returns a URL, valid for 10 minutes, to download the actual transcript.
 * The exact JSON field the URL comes back under is NOT independently
 * confirmed, this reads a couple of plausible names defensively and throws
 * a clear error if none match, rather than silently returning undefined.
 */
export async function fetchTranscriptUrl(
  creds: GenesysCloudCredentials,
  accessToken: string,
  conversationId: string,
  communicationId: string,
): Promise<string> {
  const res = await fetch(
    `${creds.apiBaseUrl}/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${communicationId}/transcripturl`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Genesys transcript URL request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const url = (data.url ?? data.transcriptUrl ?? data.uri) as string | undefined;
  if (!url) {
    throw new Error(
      `Genesys transcript URL response didn't contain a recognizable URL field, got keys: ${Object.keys(data).join(", ")}. Update fetchTranscriptUrl() with the real field name.`,
    );
  }
  return url;
}

/** Downloads the transcript document itself. Returns raw, unparsed JSON,
 *  see mapper.ts for why this stays unparsed at this layer. */
export async function downloadTranscript(transcriptUrl: string): Promise<unknown> {
  const res = await fetch(transcriptUrl);
  if (!res.ok) {
    throw new Error(`Downloading transcript document failed: ${res.status}`);
  }
  return res.json();
}
