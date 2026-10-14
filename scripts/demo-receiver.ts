/**
 * A stand-in for "your system" in the architecture diagram. Verifies the
 * HMAC signature the bridge sends and pretty-prints the normalized
 * conversation. Point OUTBOUND_WEBHOOK_URL at this while trying the bridge
 * out, this is not something you'd run in production, it's here purely so
 * the demo is fully self-contained.
 */
import "dotenv/config";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.env.DEMO_RECEIVER_PORT ?? 4000);
const secret = process.env.OUTBOUND_WEBHOOK_SECRET;

if (!secret) {
  console.error("OUTBOUND_WEBHOOK_SECRET must be set (same value as the bridge's .env) to verify signatures.");
  process.exit(1);
}

function isValidSignature(rawBody: string, header: string | undefined): boolean {
  const expected = "sha256=" + createHmac("sha256", secret!).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.use(express.text({ type: "*/*" })); // read as raw text so we can verify the signature over the exact bytes

app.post("/receive", (req, res) => {
  const rawBody = req.body as string;
  const signature = req.header("X-Bridge-Signature");

  if (!isValidSignature(rawBody, signature)) {
    console.log("\n\x1b[31m✗ Signature verification FAILED, rejecting\x1b[0m");
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const payload = JSON.parse(rawBody);
  console.log("\n\x1b[32m✓ Signature verified\x1b[0m: received conversation for contact " + payload.call_uuid);
  console.log(`  channel: ${payload.channel}   categories: ${payload.matched_categories.join(", ") || "(none)"}`);
  console.log(`  customer phone: ${payload.customer_phone ?? "(unknown, no CTR enrichment)"}`);
  console.log("");
  for (const turn of payload.conversation) {
    const label = turn.speaker.padEnd(8);
    console.log(`  ${label} ${turn.text}`);
  }
  console.log("");

  res.status(200).json({ received: true });
});

app.listen(port, () => {
  console.log(`Demo receiver listening on http://localhost:${port}/receive`);
  console.log("Point OUTBOUND_WEBHOOK_URL at that address in the bridge's .env, then run npm run demo:replay.");
});
