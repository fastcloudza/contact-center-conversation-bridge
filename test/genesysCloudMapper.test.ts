import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mapTranscriptDocumentToTurns, mapToSourceTranscript } from "../src/adapters/genesysCloud/mapper.js";
import { createLogger } from "../src/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger("error"); // silence info/warn noise in test output
const guessFixture = JSON.parse(
  readFileSync(
    path.join(__dirname, "..", "fixtures", "genesys-cloud", "sample-transcript-guess.json"),
    "utf-8",
  ),
);

test("IF the real payload matches our guessed shape, mapping produces agent/customer turns", () => {
  // This test documents an assumption, not a confirmed fact, see
  // src/adapters/genesysCloud/README.md. It exists so that if someone
  // updates the guessed shape in types.ts, they have to consciously update
  // this fixture too, rather than the assumption drifting silently.
  const turns = mapTranscriptDocumentToTurns(guessFixture, logger);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "agent");
  assert.equal(turns[1].speaker, "customer");
  assert.equal(turns[1].text, "I never received my refund from last week.");
  assert.equal(turns[1].startMs, 3400);
});

test("an unrecognized payload shape degrades to zero turns, not a crash or fabricated data", () => {
  const turns = mapTranscriptDocumentToTurns({ somethingElse: true }, logger);
  assert.deepEqual(turns, []);
});

test("mapToSourceTranscript carries the conversation id through regardless of transcript shape", () => {
  const result = mapToSourceTranscript("conv-123", guessFixture, null, logger);
  assert.equal(result.sourceContactId, "conv-123");
  assert.equal(result.turns.length, 2);
  assert.equal(result.sentimentOverall, null);
});
