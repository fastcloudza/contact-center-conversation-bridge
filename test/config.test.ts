import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "dotenv";
import { loadConfig, analysisPrefixes } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));

const required = {
  INBOUND_API_KEY: "x".repeat(20),
  OUTBOUND_WEBHOOK_URL: "http://localhost:4000/receive",
  OUTBOUND_WEBHOOK_SECRET: "y".repeat(20),
};

const OFF = ["false", "FALSE", "False", "0", "no", "No", "n", "off", "OFF", " false ", "\tfalse"];
const ON = ["true", "TRUE", "True", "1", "yes", "Yes", "y", "on", "ON", " true "];

test("every reasonable 'off' spelling turns demo mode and the adapter off", () => {
  for (const v of OFF) {
    const c = loadConfig({ ...required, AMAZON_CONNECT_DEMO_MODE: v, AMAZON_CONNECT_ENABLED: v });
    assert.equal(c.AMAZON_CONNECT_DEMO_MODE, false, `DEMO_MODE=${JSON.stringify(v)} should be off`);
    assert.equal(c.AMAZON_CONNECT_ENABLED, false, `ENABLED=${JSON.stringify(v)} should be off`);
  }
});

test("every reasonable 'on' spelling turns the setting on", () => {
  for (const v of ON) {
    const c = loadConfig({ ...required, AMAZON_CONNECT_DEMO_MODE: v, AMAZON_CONNECT_ENABLED: v });
    assert.equal(c.AMAZON_CONNECT_DEMO_MODE, true, `DEMO_MODE=${JSON.stringify(v)} should be on`);
    assert.equal(c.AMAZON_CONNECT_ENABLED, true, `ENABLED=${JSON.stringify(v)} should be on`);
  }
});

test("unset or blank settings use the documented defaults (enabled on, demo mode off)", () => {
  for (const env of [{}, { AMAZON_CONNECT_ENABLED: "", AMAZON_CONNECT_DEMO_MODE: "" }, { AMAZON_CONNECT_ENABLED: "  " }]) {
    const c = loadConfig({ ...required, ...env });
    assert.equal(c.AMAZON_CONNECT_ENABLED, true);
    assert.equal(c.AMAZON_CONNECT_DEMO_MODE, false);
  }
});

test("an unrecognised value fails loudly instead of silently picking a side", () => {
  for (const v of ["maybe", "2", "disabled", "tru"]) {
    assert.throws(
      () => loadConfig({ ...required, AMAZON_CONNECT_DEMO_MODE: v }),
      /AMAZON_CONNECT_DEMO_MODE|must be one of/,
      `DEMO_MODE=${JSON.stringify(v)} should be rejected`,
    );
  }
});

test(".env.example copied unchanged gives the behaviour the README promises", () => {
  const example = parse(readFileSync(join(here, "..", ".env.example")));
  const c = loadConfig({ ...example });
  assert.equal(c.AMAZON_CONNECT_DEMO_MODE, false, "demo mode must be OFF by default");
  assert.equal(c.AMAZON_CONNECT_ENABLED, true, "adapter must be ON by default");
});

test("README follows the demo instructions: setting DEMO_MODE=true then turns it on", () => {
  const example = parse(readFileSync(join(here, "..", ".env.example")));
  const c = loadConfig({ ...example, AMAZON_CONNECT_DEMO_MODE: "true" });
  assert.equal(c.AMAZON_CONNECT_DEMO_MODE, true);
});

test("the analysis prefix setting can hold several prefixes", () => {
  assert.deepEqual(analysisPrefixes("Analysis/Voice/, Analysis/Chat/"), ["Analysis/Voice/", "Analysis/Chat/"]);
  assert.deepEqual(analysisPrefixes("Analysis/"), ["Analysis/"]);
  const c = loadConfig({ ...required });
  assert.deepEqual(analysisPrefixes(c.AMAZON_CONNECT_ANALYSIS_PATH_PREFIX), ["Analysis/Voice/", "Analysis/Chat/"]);
});
