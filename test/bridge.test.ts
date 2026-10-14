import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createS3Client } from "../src/adapters/amazonConnect/s3.js";
import { buildServer } from "../src/server.js";
import { secretsMatch } from "../src/auth.js";
import { isPermanentS3Error } from "../src/adapters/amazonConnect/router.js";

const KEY = "k".repeat(24);

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A stand in for the receiving webhook. Records what it gets. */
async function startReceiver(status: number, delayMs: number) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end("{}");
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { received, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function startBridge(receiverPort: number) {
  const config = loadConfig({
    INBOUND_API_KEY: KEY,
    OUTBOUND_WEBHOOK_URL: `http://localhost:${receiverPort}/receive`,
    OUTBOUND_WEBHOOK_SECRET: "s".repeat(24),
    AMAZON_CONNECT_DEMO_MODE: "true",
  });
  const logger = createLogger("error");
  const app = buildServer({ config, s3: createS3Client(config), logger });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://localhost:${port}/webhook/amazon-connect`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function event(key: string) {
  return {
    "detail-type": "Object Created",
    source: "aws.s3",
    detail: { bucket: { name: "b" }, object: { key } },
  };
}

const GOOD_KEY = "Analysis/Voice/2026/09/14/a1b2c3d4-e5f6-7890-abcd-ef1234567890_analysis_2026-09-14T12:00:00Z.json";

async function waitFor(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("secretsMatch compares in constant time and handles different lengths", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abc", "abd"), false);
  assert.equal(secretsMatch("abc", "abcdef"), false);
  assert.equal(secretsMatch("", "abc"), false);
});

test("the inbound key is required", async () => {
  const rx = await startReceiver(200, 0);
  const bridge = await startBridge(rx.port);
  try {
    const none = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event(GOOD_KEY)) });
    assert.equal(none.status, 401);
    const wrong = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "nope" }, body: JSON.stringify(event(GOOD_KEY)) });
    assert.equal(wrong.status, 401);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

test("replies 200 before a slow receiver finishes, then forwards with a vendor neutral header", async () => {
  const rx = await startReceiver(200, 800);
  const bridge = await startBridge(rx.port);
  try {
    const started = Date.now();
    const res = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify(event(GOOD_KEY)) });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: true });
    assert.ok(elapsed < 600, `reply took ${elapsed} ms, it should not wait for the receiver`);

    await waitFor(() => rx.received.length === 1);
    assert.equal(rx.received[0].headers["x-bridge-event"], "conversation.normalized");
    assert.ok(String(rx.received[0].headers["x-bridge-signature"]).startsWith("sha256="));
  } finally {
    await bridge.close();
    await rx.close();
  }
});

test("a receiver that rejects with 4xx is tried once, not repeated", async () => {
  const rx = await startReceiver(400, 0);
  const bridge = await startBridge(rx.port);
  try {
    const res = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify(event(GOOD_KEY)) });
    assert.equal(res.status, 200);
    await waitFor(() => rx.received.length >= 1);
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(rx.received.length, 1);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

test("a key outside the prefix is skipped with 200", async () => {
  const rx = await startReceiver(200, 0);
  const bridge = await startBridge(rx.port);
  try {
    const res = await fetch(bridge.url, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify(event("Other/file.json")) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { skipped: true, reason: "outside_analysis_prefix" });
    assert.equal(rx.received.length, 0);
  } finally {
    await bridge.close();
    await rx.close();
  }
});

test("S3 errors that retrying cannot fix are recognised", () => {
  assert.equal(isPermanentS3Error({ name: "NoSuchKey" }), true);
  assert.equal(isPermanentS3Error({ name: "AccessDenied" }), true);
  assert.equal(isPermanentS3Error({ $metadata: { httpStatusCode: 404 } }), true);
  assert.equal(isPermanentS3Error(new SyntaxError("bad json")), true);
  assert.equal(isPermanentS3Error({ name: "TimeoutError" }), false);
  assert.equal(isPermanentS3Error({ $metadata: { httpStatusCode: 503 } }), false);
});
