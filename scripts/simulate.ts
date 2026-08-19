/**
 * Runs the corpus through three strategies and prints what each one costs.
 *
 * This is the number the README leads with, and it is produced by the package
 * itself — not typed in by hand. `npm run simulate` reproduces it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createLadder, whenFieldsMissing, whenTruncated, whenUngrounded } from "../src/index.js";
import { costOf } from "../src/pricing.js";
import type { ModelReply, PricingTable, SpendRecord } from "../src/index.js";

interface Fixture {
  id: string;
  text: string;
  truth: { vendor: string };
  fast: Recorded;
  strong: Recorded;
}

interface Recorded {
  vendor: string;
  stopReason: "end" | "length";
  usage: { inputTokens: number; outputTokens: number };
}

interface Extracted {
  vendor: string;
}

/**
 * List prices per million tokens, in USD. Illustrative and deliberately
 * provider-neutral: swap in yours, the shape of the answer will not change.
 */
const PRICING: PricingTable = {
  fast: { inputPer1M: 1, outputPer1M: 5 },
  strong: { inputPer1M: 15, outputPer1M: 75 },
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "documents.json"), "utf8"),
);

const replyOf = (recorded: Recorded): ModelReply<Extracted> => ({
  value: { vendor: recorded.vendor },
  usage: recorded.usage,
  stopReason: recorded.stopReason,
});

/** A vendor counts as correct when it names the same company, suffix aside. */
function isCorrect(answer: string, truth: string): boolean {
  if (answer.trim() === "") return false;
  const a = answer.toLowerCase();
  const t = truth.toLowerCase();
  return t.startsWith(a) || a.startsWith(t.split(" ")[0] as string);
}

function summarize(label: string, results: Array<{ correct: boolean; costUsd: number }>) {
  const total = results.reduce((sum, r) => sum + r.costUsd, 0);
  const correct = results.filter((r) => r.correct).length;
  return {
    label,
    per1000: (total / results.length) * 1000,
    accuracy: (correct / results.length) * 100,
  };
}

// 1. Cheap model only.
const fastOnly = fixtures.map((fixture) => ({
  correct: isCorrect(fixture.fast.vendor, fixture.truth.vendor),
  costUsd: costOf(fixture.fast.usage, PRICING["fast"]!),
}));

// 2. Strong model only.
const strongOnly = fixtures.map((fixture) => ({
  correct: isCorrect(fixture.strong.vendor, fixture.truth.vendor),
  costUsd: costOf(fixture.strong.usage, PRICING["strong"]!),
}));

// 3. The ladder.
const records: SpendRecord[] = [];
const ladderResults: Array<{ correct: boolean; costUsd: number }> = [];

for (const fixture of fixtures) {
  const ladder = createLadder<Fixture, Extracted>({
    fast: { name: "fast", call: async () => replyOf(fixture.fast) },
    strong: { name: "strong", call: async () => replyOf(fixture.strong) },
    escalateWhen: [
      whenTruncated(),
      whenFieldsMissing(["vendor"]),
      whenUngrounded({ field: "vendor", sourceText: (doc) => doc.text }),
    ],
    pricing: PRICING,
    onSpend: (record) => records.push(record),
  });

  const outcome = await ladder.run(fixture);
  const answer = outcome.status === "unavailable" ? "" : outcome.value.vendor;
  ladderResults.push({
    correct: isCorrect(answer, fixture.truth.vendor),
    costUsd: outcome.costUsd,
  });
}

const rows = [
  summarize("Cheap model only", fastOnly),
  summarize("Strong model only", strongOnly),
  summarize("Ladder", ladderResults),
];

const escalated = records.filter((r) => r.status === "escalated").length;
const byReason = new Map<string, number>();
for (const record of records) {
  if (record.status === "escalated" && record.reason) {
    byReason.set(record.reason.code, (byReason.get(record.reason.code) ?? 0) + 1);
  }
}

const strongOnlyCost = rows[1]!.per1000;
const ladderCost = rows[2]!.per1000;

console.log(`\ncorpus: ${fixtures.length} documents\n`);
console.log("| Strategy | Cost per 1000 documents | Correct vendor |");
console.log("|---|---|---|");
for (const row of rows) {
  console.log(`| ${row.label} | $${row.per1000.toFixed(2)} | ${row.accuracy.toFixed(1)}% |`);
}

console.log(
  `\nescalated: ${escalated} of ${fixtures.length} (${((escalated / fixtures.length) * 100).toFixed(1)}%)`,
);
for (const [code, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code}: ${count}`);
}
console.log(
  `\nladder vs strong-only: ${(((strongOnlyCost - ladderCost) / strongOnlyCost) * 100).toFixed(1)}% cheaper, ` +
    `${(rows[1]!.accuracy - rows[2]!.accuracy).toFixed(1)} points of accuracy given up\n`,
);
