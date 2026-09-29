import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { verificationFailureExcerpt } from "../src/lib/peach-workspace.mjs";

test("landing verification failures keep a bounded, readable output tail", () => {
  const noise = Array.from({ length: 200 }, (_, index) => `\u001b[32mpass ${index}\u001b[0m`);
  const excerpt = verificationFailureExcerpt({
    stdout: [...noise, "", "FAIL tests/unit/example.test.ts > behaves"].join("\n"),
    stderr: "(node:1) ExperimentalWarning: SQLite is experimental\n(Use `node --trace-warnings ...`)\nAssertionError: expected 1\n",
  });
  const lines = excerpt.split("\n");
  assert.equal(lines.length, 60);
  assert.equal(lines.at(-1), "AssertionError: expected 1");
  assert.ok(lines.includes("FAIL tests/unit/example.test.ts > behaves"));
  assert.ok(!excerpt.includes("\u001b["));
  assert.ok(!excerpt.includes("ExperimentalWarning"));
});
