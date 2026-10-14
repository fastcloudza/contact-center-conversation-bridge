/**
 * Sends exactly the shape of request EventBridge would send after an S3
 * Object Created event. Two ways to use it:
 *   Demo mode: the bridge runs with AMAZON_CONNECT_DEMO_MODE=true and serves a
 *   local fixture, so no AWS account is needed (README, "Try it without AWS").
 *   Real bucket: set REPLAY_BUCKET and REPLAY_KEY and run the bridge with demo
 *   mode off and AWS credentials set (README, "Run it against a real bucket").
 */
import "dotenv/config";

const bridgePort = process.env.PORT ?? "8080";
const bridgeUrl = process.env.BRIDGE_URL ?? `http://localhost:${bridgePort}/webhook/amazon-connect`;
const apiKeyHeader = process.env.INBOUND_API_KEY_HEADER ?? "x-api-key";
const apiKey = process.env.INBOUND_API_KEY;
// The setting may list several prefixes separated by commas; use the first.
const prefix = (process.env.AMAZON_CONNECT_ANALYSIS_PATH_PREFIX ?? "Analysis/Voice/").split(",")[0].trim();

if (!apiKey) {
  console.error("INBOUND_API_KEY must be set (same value as the bridge's .env).");
  process.exit(1);
}

// To replay against a real bucket, set REPLAY_BUCKET and REPLAY_KEY (the key
// exactly as S3 shows it). The bridge then reads that real file. Without
// them, a made up key is used, which only works in demo mode.
const replayBucket = process.env.REPLAY_BUCKET ?? "demo-connect-bucket";
const replayKey =
  process.env.REPLAY_KEY ??
  `${prefix}2026/09/14/a1b2c3d4-e5f6-7890-abcd-ef1234567890_analysis_2026-09-14T12:00:00Z.json`;
const replayRegion = process.env.AMAZON_CONNECT_AWS_REGION ?? "us-east-1";

const syntheticEvent = {
  version: "0",
  id: "demo-event-" + Date.now(),
  "detail-type": "Object Created",
  source: "aws.s3",
  account: "123456789012",
  time: new Date().toISOString(),
  region: replayRegion,
  resources: [`arn:aws:s3:::${replayBucket}`],
  detail: {
    bucket: { name: replayBucket },
    // The key just needs to start with ANALYSIS_PATH_PREFIX and end in
    // .json to pass the bridge's own filter, DemoAnalysisFetcher ignores
    // the actual path and always serves fixtures/amazon-connect/sample-analysis.json (the contact ID is then read from this file name, as documented).
    object: { key: replayKey },
    "request-id": "demo-request-id",
    reason: "PutObject",
  },
};

const res = await fetch(bridgeUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    [apiKeyHeader]: apiKey,
  },
  body: JSON.stringify(syntheticEvent),
});

const body = await res.json().catch(() => ({}));
console.log(`Bridge responded ${res.status}:`, body);

if (res.ok) {
  console.log("\nCheck the demo receiver's terminal, the normalized conversation should have just landed there.");
} else {
  console.log("\nSomething didn't work, check the bridge's own log output for details.");
}
