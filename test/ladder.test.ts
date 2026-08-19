import { describe, it, expect, vi } from "vitest";

import {
  createLadder,
  LEGAL_SUFFIXES,
  MissingPriceError,
  whenFieldsMissing,
  whenInvalid,
  whenTruncated,
  whenUngrounded,
} from "../src/index.js";
import type { ModelReply, PricingTable, SpendRecord } from "../src/index.js";

interface Doc {
  text: string;
}

interface Extracted {
  vendor: string;
  total: number | null;
}

// Prices live in the caller's config, not in the package.
const PRICING: PricingTable = {
  fast: { inputPer1M: 1, outputPer1M: 5 },
  strong: { inputPer1M: 15, outputPer1M: 75 },
};

const USAGE = { inputTokens: 2_000, outputTokens: 200 };

function reply(value: Extracted, extra: Partial<ModelReply<Extracted>> = {}) {
  return async (): Promise<ModelReply<Extracted>> => ({
    value,
    usage: USAGE,
    ...extra,
  });
}

function ladder(overrides: {
  fast: () => Promise<ModelReply<Extracted>>;
  strong?: () => Promise<ModelReply<Extracted>>;
  escalateWhen?: Parameters<typeof createLadder<Doc, Extracted>>[0]["escalateWhen"];
  budget?: { take(): Promise<boolean> };
  onSpend?: (record: SpendRecord) => void;
}) {
  return createLadder<Doc, Extracted>({
    fast: { name: "fast", call: overrides.fast },
    strong: {
      name: "strong",
      call: overrides.strong ?? reply({ vendor: "ACME Corporation", total: 118 }),
    },
    escalateWhen: overrides.escalateWhen ?? [whenFieldsMissing(["vendor"])],
    pricing: PRICING,
    ...(overrides.budget ? { budget: overrides.budget } : {}),
    ...(overrides.onSpend ? { onSpend: overrides.onSpend } : {}),
  });
}

describe("the cheap path", () => {
  it("keeps the cheap answer and never calls the strong model", async () => {
    const strong = vi.fn(reply({ vendor: "never", total: 0 }));
    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corporation", total: 118 }),
      strong,
    }).run({ text: "invoice from ACME Corporation, total 118" });

    expect(outcome.status).toBe("fast");
    expect(strong).not.toHaveBeenCalled();
    // 2000 in at $1/M + 200 out at $5/M
    expect(outcome.costUsd).toBeCloseTo(0.003, 6);
  });
});

describe("escalation", () => {
  it("pays for the strong model once and returns its answer", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "", total: 118 }),
      strong: reply({ vendor: "ACME Corporation", total: 118 }),
    }).run({ text: "…" });

    expect(outcome.status).toBe("escalated");
    if (outcome.status !== "escalated") return;

    expect(outcome.value.vendor).toBe("ACME Corporation");
    expect(outcome.reason.code).toBe("missing-fields");
    expect(outcome.attempts).toHaveLength(2);
    // Both calls are billed: 0.003 + 0.045
    expect(outcome.costUsd).toBeCloseTo(0.048, 6);
  });

  it("escalates a truncated answer", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "ACME", total: 118 }, { stopReason: "length" }),
      escalateWhen: [whenTruncated()],
    }).run({ text: "…" });

    expect(outcome.status).toBe("escalated");
  });

  it("reports which check objected, not just that one did", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "", total: null }),
      escalateWhen: [whenTruncated(), whenFieldsMissing(["vendor", "total"])],
    }).run({ text: "…" });

    if (outcome.status !== "escalated") throw new Error("expected an escalation");
    expect(outcome.reason).toEqual({
      code: "missing-fields",
      detail: "vendor, total",
    });
  });
});

describe("a provider that does not answer", () => {
  it("is not an escalation when the cheap model fails", async () => {
    const strong = vi.fn(reply({ vendor: "ACME", total: 1 }));
    const outcome = await ladder({
      fast: async () => {
        throw new Error("503 from the provider");
      },
      strong,
    }).run({ text: "…" });

    expect(outcome.status).toBe("unavailable");
    // A broken network must not be answered by spending more.
    expect(strong).not.toHaveBeenCalled();
    expect(outcome.costUsd).toBe(0);
  });

  it("degrades to the cheap answer when the strong model fails", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "", total: 118 }),
      strong: async () => {
        throw new Error("timeout");
      },
    }).run({ text: "…" });

    expect(outcome.status).toBe("degraded");
    if (outcome.status !== "degraded") return;

    expect(outcome.cause).toBe("provider");
    // The document is not lost.
    expect(outcome.value.total).toBe(118);
    expect(outcome.reason.code).toBe("missing-fields");
    // With the provider's message, so a timeout is distinguishable from a bad key.
    expect((outcome.error as Error).message).toBe("timeout");
  });
});

describe("budget", () => {
  it("degrades instead of failing when the budget is spent", async () => {
    const strong = vi.fn(reply({ vendor: "ACME", total: 1 }));
    const outcome = await ladder({
      fast: reply({ vendor: "", total: 118 }),
      strong,
      budget: { take: async () => false },
    }).run({ text: "…" });

    expect(outcome.status).toBe("degraded");
    if (outcome.status !== "degraded") return;

    expect(outcome.cause).toBe("budget");
    expect(strong).not.toHaveBeenCalled();
    // Only the cheap call was billed.
    expect(outcome.costUsd).toBeCloseTo(0.003, 6);
  });

  it("degrades instead of spending when the budget counter is unreachable", async () => {
    const strong = vi.fn(reply({ vendor: "ACME", total: 1 }));
    const outcome = await ladder({
      fast: reply({ vendor: "", total: 118 }),
      strong,
      budget: {
        take: async () => {
          throw new Error("connection refused");
        },
      },
    }).run({ text: "…" });

    expect(outcome.status).toBe("degraded");
    if (outcome.status !== "degraded") return;

    // The remaining budget is unknown, so we do not spend.
    expect(strong).not.toHaveBeenCalled();
    expect(outcome.cause).toBe("budget");
    expect((outcome.error as Error).message).toBe("connection refused");
  });

  it("does not touch the budget when the cheap answer is accepted", async () => {
    const take = vi.fn(async () => true);
    await ladder({
      fast: reply({ vendor: "ACME Corporation", total: 118 }),
      budget: { take },
    }).run({ text: "…" });

    expect(take).not.toHaveBeenCalled();
  });
});

describe("accounting", () => {
  it("reports every run through onSpend, including the ones that cost nothing", async () => {
    const records: SpendRecord[] = [];

    await ladder({
      fast: reply({ vendor: "ACME Corporation", total: 118 }),
      onSpend: (record) => records.push(record),
    }).run({ text: "…" });

    await ladder({
      fast: async () => {
        throw new Error("down");
      },
      onSpend: (record) => records.push(record),
    }).run({ text: "…" });

    expect(records.map((record) => record.status)).toEqual(["fast", "unavailable"]);
    expect(records[1]?.costUsd).toBe(0);
  });

  it("hands the provider error to onSpend, not just to the caller", async () => {
    const records: SpendRecord[] = [];

    await ladder({
      fast: reply({ vendor: "", total: 118 }),
      strong: async () => {
        throw new Error("502");
      },
      onSpend: (record) => records.push(record),
    }).run({ text: "…" });

    expect((records[0]?.error as Error).message).toBe("502");
  });

  it("does not lose a paid-for document because the metrics sink threw", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corporation", total: 118 }),
      onSpend: () => {
        throw new Error("statsd is down");
      },
    }).run({ text: "…" });

    expect(outcome.status).toBe("fast");
    // Ignored, but logged.
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("refuses to build a ladder whose models have no price", () => {
    expect(() =>
      createLadder<Doc, Extracted>({
        fast: { name: "unpriced", call: reply({ vendor: "x", total: 1 }) },
        strong: { name: "strong", call: reply({ vendor: "x", total: 1 }) },
        escalateWhen: [],
        pricing: PRICING,
      }),
    ).toThrow(MissingPriceError);
  });
});

describe("a validator of your own", () => {
  // The shape zod's safeParse already returns, minus the parsed data.
  const totalIsPositive = whenInvalid<Doc, Extracted>((value) =>
    value.total !== null && value.total > 0
      ? { ok: true }
      : { ok: false, detail: "total must be a positive number" },
  );

  it("accepts a value the validator approves", async () => {
    const strong = vi.fn(reply({ vendor: "ACME", total: 1 }));
    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corporation", total: 118 }),
      strong,
      escalateWhen: [totalIsPositive],
    }).run({ text: "…" });

    expect(outcome.status).toBe("fast");
    expect(strong).not.toHaveBeenCalled();
  });

  it("escalates on rejection and passes the validator's message through", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corporation", total: -4 }),
      escalateWhen: [totalIsPositive],
    }).run({ text: "…" });

    expect(outcome.status).toBe("escalated");
    if (outcome.status !== "escalated") return;

    expect(outcome.reason).toEqual({
      code: "schema-miss",
      detail: "total must be a positive number",
    });
  });

  it("omits detail when the validator gives none", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corporation", total: -4 }),
      escalateWhen: [whenInvalid<Doc, Extracted>(() => ({ ok: false }))],
    }).run({ text: "…" });

    if (outcome.status !== "escalated") throw new Error("expected an escalation");
    expect(outcome.reason).toEqual({ code: "schema-miss" });
  });
});

describe("grounding a field in the source text", () => {
  const grounded = whenUngrounded<Doc, Extracted>({
    field: "vendor",
    sourceText: (doc) => doc.text,
  });

  const longEnough = (body: string) => `${body} — invoice no. 4471, issued 2026-02-11, page 1 of 2`;

  it("accepts a name that differs only by legal suffix and case", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "ACME Corp.", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("Bill from ACME CORPORATION") });

    expect(outcome.status).toBe("fast");
  });

  it("accepts a name that the text layer letter-spaced", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "ACME", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("A C M E   header block") });

    expect(outcome.status).toBe("fast");
  });

  it("accepts a two-word name in a letter-spaced heading", async () => {
    // The word boundary is lost along with the letter ones.
    const outcome = await ladder({
      fast: reply({ vendor: "Globex Industries", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("G l o b e x   I n d u s t r i e s") });

    expect(outcome.status).toBe("fast");
  });

  it("does not escalate a name too short to ground", async () => {
    // One letter matches almost any document. An empty field would be caught
    // by `missing-fields` first.
    const outcome = await ladder({
      fast: reply({ vendor: "E Corp.", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("Bill from ACME CORPORATION") });

    expect(outcome.status).toBe("fast");
  });

  it("escalates a name that is nowhere in the text", async () => {
    const outcome = await ladder({
      fast: reply({ vendor: "Globex", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("Bill from ACME CORPORATION") });

    expect(outcome.status).toBe("escalated");
    if (outcome.status !== "escalated") return;
    expect(outcome.reason.code).toBe("ungrounded");
  });

  it("accepts a Cyrillic name whose legal form moved or appeared", async () => {
    // `ООО` leads the name as often as it trails it, so word order must not
    // decide whether the vendor counts as grounded.
    const outcome = await ladder({
      fast: reply({ vendor: "ООО Ромашка", total: 118 }),
      escalateWhen: [grounded],
    }).run({ text: longEnough("Счёт от компании Ромашка") });

    expect(outcome.status).toBe("fast");
  });

  it("takes a suffix list of your own", async () => {
    const polish = whenUngrounded<Doc, Extracted>({
      field: "vendor",
      sourceText: (doc) => doc.text,
      // Entries are tokens as `normalize` produces them, so `sp. z o.o.`
      // contributes "sp", "z" and "o" rather than one string.
      legalSuffixes: [...LEGAL_SUFFIXES, "sp", "z", "o"],
    });

    const outcome = await ladder({
      fast: reply({ vendor: "Kowalski sp. z o.o.", total: 118 }),
      escalateWhen: [polish],
      strong: reply({ vendor: "never", total: 0 }),
    }).run({ text: longEnough("Faktura od Kowalski") });

    expect(outcome.status).toBe("fast");
  });

  it("skips the check when the document has no text layer", async () => {
    const strong = vi.fn(reply({ vendor: "ACME", total: 1 }));
    const outcome = await ladder({
      fast: reply({ vendor: "Globex", total: 118 }),
      strong,
      escalateWhen: [grounded],
    }).run({ text: "" });

    // A photo grounds nothing, and escalating every one of them just changes
    // the default model.
    expect(outcome.status).toBe("fast");
    expect(strong).not.toHaveBeenCalled();
  });
});
