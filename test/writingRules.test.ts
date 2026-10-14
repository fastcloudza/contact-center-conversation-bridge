import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, extname, basename } from "node:path";

// Enforces docs/writing-rules.md. Syntax is exempt: markdown list markers,
// table rules, arrows, arithmetic and command options are not flagged.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const SKIP_FILES = new Set(["package-lock.json", "LICENSE"]);
const TEXT_EXT = new Set([".ts", ".md", ".json", ".example", ".js", ""]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...files(p));
    } else if (!SKIP_FILES.has(name) && TEXT_EXT.has(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

// Code points 0x2010 to 0x2015 (hyphen variants, en and em dash, bar) and 0x2212 (minus).
const DASHES = new RegExp("[" + String.fromCharCode(0x2010) + "-" + String.fromCharCode(0x2015) + String.fromCharCode(0x2212) + "]");

function problems(file: string, text: string): string[] {
  const found: string[] = [];
  const isMd = extname(file) === ".md";
  text.split("\n").forEach((line, i) => {
    const where = `${relative(root, file)}:${i + 1}`;
    const t = line.trim();
    if (DASHES.test(line)) found.push(`${where} em/en dash: ${t}`);
    const isTableRule = /^\|?[\s:|-]+\|[\s:|-]*$/.test(t);
    const isMdRule = isMd && /^-{3,}$/.test(t);
    if (/-{3,}/.test(line) && !isTableRule && !isMdRule && !t.startsWith("\"integrity\"")) {
      found.push(`${where} row of hyphens: ${t}`);
    }
    const isComment = /^(\/\/|\/\*|\*|#)/.test(t);
    if ((isComment || isMd) && /\S - \S/.test(t) && !(isMd && isTableRule)) {
      found.push(`${where} hyphen as punctuation: ${t}`);
    }
  });
  return found;
}

test("no em dashes, en dashes or hyphen punctuation in prose, comments or messages", () => {
  const all = files(root).flatMap((f) => problems(f, readFileSync(f, "utf-8")));
  assert.deepEqual(all, [], "see docs/writing-rules.md\n" + all.join("\n"));
});

test("the checker itself catches the things it is meant to catch", () => {
  const f = join(root, "x.md");
  assert.equal(problems(f, "one " + String.fromCharCode(0x2014) + " two").length, 1);
  assert.equal(problems(f, "one " + String.fromCharCode(0x2013) + " two").length, 1);
  assert.equal(problems(f, "one - two").length, 1);
  assert.equal(problems(join(root, "x.ts"), "// " + "-".repeat(3) + " Section " + "-".repeat(3)).length >= 1, true);
  assert.equal(problems(f, "|" + "-".repeat(3) + "|" + "-".repeat(3) + "|").length, 0);
  assert.equal(problems(f, "a vendor-agnostic tool").length, 0);
  assert.equal(problems(join(root, "x.ts"), "const n = a - 1;").length, 0);
  assert.equal(basename(f), "x.md");
});
