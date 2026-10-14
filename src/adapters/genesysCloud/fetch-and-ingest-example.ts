/**
 * Reference example, not wired into the running server. Genesys Cloud is a
 * pull/query model (see README.md in this folder for why), so there's no
 * webhook route to mount, the missing piece is however you detect "this
 * conversation just finished being analyzed" on your own tenant.
 *
 * Once you have that trigger sorted, call this with a real conversationId
 * and communicationId to see the fetch -> map -> ingest path run for real:
 *
 *   GENESYS_LOGIN_BASE_URL=https://login.mypurecloud.com \
 *   GENESYS_API_BASE_URL=https://api.mypurecloud.com \
 *   GENESYS_CLIENT_ID=... GENESYS_CLIENT_SECRET=... \
 *   tsx src/adapters/genesysCloud/fetch-and-ingest-example.ts <conversationId> <communicationId>
 */
import "dotenv/config";
import { loadConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { ingestConversation } from "../../ingest.js";
import {
  fetchAccessToken,
  fetchConversationSentiment,
  fetchTranscriptUrl,
  downloadTranscript,
  type GenesysCloudCredentials,
} from "./client.js";
import { mapToSourceTranscript, mapToIdentityInfo } from "./mapper.js";

const [conversationId, communicationId] = process.argv.slice(2);
if (!conversationId || !communicationId) {
  console.error("Usage: tsx fetch-and-ingest-example.ts <conversationId> <communicationId>");
  process.exit(1);
}

const creds: GenesysCloudCredentials = {
  loginBaseUrl: process.env.GENESYS_LOGIN_BASE_URL ?? "",
  apiBaseUrl: process.env.GENESYS_API_BASE_URL ?? "",
  clientId: process.env.GENESYS_CLIENT_ID ?? "",
  clientSecret: process.env.GENESYS_CLIENT_SECRET ?? "",
};
if (!creds.loginBaseUrl || !creds.apiBaseUrl || !creds.clientId || !creds.clientSecret) {
  console.error("Set GENESYS_LOGIN_BASE_URL, GENESYS_API_BASE_URL, GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET");
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const accessToken = await fetchAccessToken(creds);
const sentiment = await fetchConversationSentiment(creds, accessToken, conversationId).catch((err) => {
  logger.warn("Couldn't fetch sentiment, continuing without it", { error: String(err) });
  return null;
});
const transcriptUrl = await fetchTranscriptUrl(creds, accessToken, conversationId, communicationId);
const transcriptDoc = await downloadTranscript(transcriptUrl);

logger.info("Fetched Genesys transcript document, first 500 chars for inspection", {
  preview: JSON.stringify(transcriptDoc).slice(0, 500),
});

const transcript = mapToSourceTranscript(conversationId, transcriptDoc, sentiment, logger);
const identity = mapToIdentityInfo();

const normalized = await ingestConversation(
  config,
  logger,
  transcript,
  identity,
  "genesys_cloud_speech_text_analytics",
  { conversationId, communicationId },
);

console.log(`Forwarded ${normalized.conversation.length} turns for conversation ${conversationId}.`);
if (normalized.conversation.length === 0) {
  console.log(
    "Zero turns usually means the transcript document didn't match mapTranscriptDocumentToTurns()'s " +
      "guessed shape, check the logged preview above against types.ts and fix the mapper.",
  );
}
