/**
 * Builds the corpus the simulation runs on.
 *
 * These are recorded replies, not live calls: the numbers in the README have to
 * be reproducible by anyone who clones the repository, and a live benchmark
 * would give a different answer every run and cost money to repeat. The prices
 * and token counts are real-world shaped; the answers are synthetic.
 *
 * Seeded, so `npm run fixtures` reproduces the same corpus byte for byte.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SEED = 20260819;
const COUNT = 500;

const VENDORS = [
  "ACME Corporation", "Globex Industries", "Initech Software", "Umbrella Supplies",
  "Soylent Foods", "Hooli Cloud", "Vehement Capital", "Massive Dynamic",
  "Cyberdyne Systems", "Stark Industries", "Wayne Enterprises", "Tyrell Optics",
];

interface Fixture {
  id: string;
  /** Text layer of the document. Empty for photos and scans. */
  text: string;
  /** The answer a human would give. Used only to score the run. */
  truth: { vendor: string };
  fast: RecordedReply;
  strong: RecordedReply;
}

interface RecordedReply {
  vendor: string;
  stopReason: "end" | "length";
  usage: { inputTokens: number; outputTokens: number };
}

const random = mulberry32(SEED);

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function between(min: number, max: number): number {
  return Math.round(min + random() * (max - min));
}

const fixtures: Fixture[] = [];

for (let index = 0; index < COUNT; index += 1) {
  const vendor = pick(VENDORS);

  // A fifth of the corpus is photos and scans: no text layer at all. This is
  // what keeps the simulation honest — grounding cannot help there.
  const hasTextLayer = random() > 0.2;
  const text = hasTextLayer ? documentText(vendor) : "";

  const inputTokens = hasTextLayer ? between(1_800, 3_400) : between(2_400, 4_200);
  const outputTokens = between(120, 260);

  // How the cheap model does: mostly right; when wrong, it either invents a
  // vendor, returns nothing, or gets cut off.
  const roll = random();
  let fastVendor = vendor;
  let fastStop: "end" | "length" = "end";

  if (roll < 0.11) {
    fastVendor = pick(VENDORS.filter((name) => name !== vendor)); // fabricated
  } else if (roll < 0.16) {
    fastVendor = ""; // gave up
  } else if (roll < 0.19) {
    fastStop = "length"; // truncated
  } else if (roll < 0.27) {
    fastVendor = shorten(vendor); // right company, suffix dropped — NOT an error
  }

  // The strong model is better, not perfect.
  const strongVendor = random() < 0.97 ? vendor : pick(VENDORS.filter((n) => n !== vendor));

  fixtures.push({
    id: `doc-${String(index + 1).padStart(3, "0")}`,
    text,
    truth: { vendor },
    fast: {
      vendor: fastVendor,
      stopReason: fastStop,
      usage: { inputTokens, outputTokens },
    },
    strong: {
      vendor: strongVendor,
      stopReason: "end",
      usage: { inputTokens, outputTokens: outputTokens + between(20, 90) },
    },
  });
}

function documentText(vendor: string): string {
  const header = random() < 0.15 ? vendor.split("").join(" ") : vendor.toUpperCase();
  return [
    header,
    `Invoice ${between(1000, 9999)} · issued 2026-0${between(1, 9)}-${between(10, 28)}`,
    "Description  Qty  Unit price  Amount",
    `Consulting services  ${between(1, 40)}  ${between(50, 400)}.00  ${between(500, 9000)}.00`,
    `VAT 18%  ${between(90, 1600)}.00`,
    "Payment due within 30 days. Bank details on the reverse side.",
  ].join("\n");
}

function shorten(vendor: string): string {
  return vendor.split(" ")[0] as string;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "fixtures", "documents.json");
writeFileSync(target, `${JSON.stringify(fixtures, null, 2)}\n`);

const withoutText = fixtures.filter((f) => f.text === "").length;
console.log(`wrote ${fixtures.length} fixtures to ${target}`);
console.log(`  ${withoutText} of them have no text layer`);
