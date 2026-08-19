# model-ladder

[![CI](https://github.com/BorisMund/model-ladder/actions/workflows/ci.yml/badge.svg)](https://github.com/BorisMund/model-ladder/actions/workflows/ci.yml)

Ask the cheap model first. Pay for the strong one only when the cheap answer is not good enough — under a budget, with a cost record for every call.

## The number

500 documents, three strategies, same corpus:

| Strategy | Cost per 1000 documents | Correct vendor |
|---|---|---|
| Cheap model only | $3.71 | 84.2% |
| Strong model only | $59.74 | 97.4% |
| **Ladder** | **$13.53** | **97.2%** |

**77% cheaper than always using the strong model, for 0.2 points of accuracy.**

16.8% of documents escalated. What asked for the escalation:

| Reason | Documents |
|---|---|
| `ungrounded` — the vendor is nowhere in the document text | 41 |
| `missing-fields` — the model returned nothing for a required field | 26 |
| `truncated` — the answer was cut off by the token limit | 17 |

Reproduce it with `npm run simulate`. The corpus is recorded, not live — see [Where the numbers come from](#where-the-numbers-come-from).

## How it works

```ts
const ladder = createLadder<Doc, Invoice>({
  fast:   { name: "fast",   call: (doc) => askFast(doc) },
  strong: { name: "strong", call: (doc) => askStrong(doc) },

  escalateWhen: [
    whenTruncated(),
    whenFieldsMissing(["vendor", "total"]),
    whenUngrounded({ field: "vendor", sourceText: (doc) => doc.text }),
  ],

  pricing: {
    fast:   { inputPer1M: 1,  outputPer1M: 5 },
    strong: { inputPer1M: 15, outputPer1M: 75 },
  },

  budget: monthlyEscalations(accountId),
  onSpend: (record) => metrics.record(record),
});

const outcome = await ladder.run(doc);
```

`outcome` is a union, not a value with flags:

```ts
switch (outcome.status) {
  case "fast":        return outcome.value;                    // the common case
  case "escalated":   return outcome.value;                    // paid for, and worth it
  case "degraded":    return flag(outcome.value, outcome.reason); // usable, less certain
  case "unavailable": throw outcome.error;                     // nothing is known
}
```

Zero runtime dependencies. Models are functions you pass in, so the tests here run without a network or an API key.

## Where the savings come from

The strong model costs 16× the cheap one per document ($0.0597 against $0.0037 on this corpus). So the whole question is what share of documents you send to it:

```
cost per document = cheap + escalation_rate × strong
```

At 16.8% that lands at $13.53 per 1000. Two consequences worth knowing before you adopt this:

1. **The escalation rate is the only knob that matters.** Doubling it costs you almost twice as much; halving it saves almost half. Tuning checks is tuning the bill.
2. **The ladder stays cheaper until 94% of documents escalate.** Break-even is `1 − cheap/strong`. That is the honest worst case: even a badly tuned ladder rarely loses to always-strong — it just stops winning much.

The trap is the opposite one. A cheap model whose answers are bad *and* undetectable gives you the cheap price and the cheap accuracy, with extra machinery. Which is why every check here reports a code, and every run is emitted through `onSpend`: if `ungrounded` is 3% of documents, the ladder is not doing much and you should know that from your dashboard, not from the invoice.

## What counts as "not good enough"

Checks are plain functions returning a reason or `null`. Four ship with the package:

| Check | Escalates when |
|---|---|
| `whenTruncated()` | The provider says the answer hit the token limit. Incomplete by definition. |
| `whenFieldsMissing([...])` | A required field came back empty. |
| `whenInvalid(validate)` | Your validator rejected the shape. Wrap zod's `safeParse` and pass it. |
| `whenUngrounded({ field, sourceText })` | A field that should appear verbatim in the document does not appear at all. |

`whenUngrounded` is the one that pays for itself — 41 of the 84 escalations above — and the one with the most careful edges:

- **Documents with no text layer are skipped, not escalated.** There is nothing to compare against. Escalating every photo is not a rare fallback; it is changing the default model, at the default model's price. A fifth of the corpus is photos, and they cost the cheap price.
- **Legal suffixes and case are normalised away.** `ACME Corp.` against a header reading `ACME CORPORATION` is the same company, not a fabrication. Without this, half the corpus escalates for nothing.
- **Letter-spaced headings are glued back together.** PDF text layers produce `A C M E` routinely — and `G l o b e x   I n d u s t r i e s`, where the word boundary is lost along with the letter ones, so the comparison is also tried with every space removed.
- **A name too short to ground is left alone.** One letter is a substring of nearly every document; escalating on it buys noise, and a genuinely empty field is `missing-fields`.
- **Only verbatim fields can be grounded.** Totals are reformatted (`1 234,56` vs `1234.56`) and dates almost always are. Grounding them produces false alarms, not signal, so don't.

## Three rules that keep it safe

1. **A provider that is down is not a reason to spend more.** If the cheap call throws, the run ends as `unavailable` and the strong model is never called. Retrying belongs to the caller; paying 16× to discover the network is broken belongs to nobody.
2. **One rung, once.** No chains. A second re-read almost never rescues a document the first one missed, and chains multiply the bill quietly.
3. **Out of budget degrades, it does not fail.** The cheap answer is returned with its reason attached. Turning "we are less sure about this one" into "we lost this document" is the worse outcome for everyone. The same holds when the budget counter itself is unreachable: whether budget is left is then unknown, and not knowing is never a reason to spend more.

## Budget

`budget` is a one-method interface — `take(): Promise<boolean>` — so the counter lives wherever your counters already live:

```ts
import { createQuotaSlots, pgExecutor } from "quota-slot";

const slots = createQuotaSlots({
  execute: pgExecutor(pool),
  table: { table: "accounts", key: "id", counter: "escalations_this_month" },
});

const monthlyEscalations = (accountId: string) => ({
  take: async () => (await slots.take(accountId, 200)) === "granted",
});
```

[quota-slot](https://github.com/BorisMund/quota-slot) does that atomically, which matters here: ten attachments from one email escalate concurrently, and a read-then-write counter hands out more escalations than the budget allows.

It is deliberately *not* a dependency. Coupling two packages to save five lines of glue is a worse trade than writing the five lines.

## Where the numbers come from

The corpus in `fixtures/` is generated by `scripts/generate-fixtures.ts` from a fixed seed: 500 documents, 104 of them without a text layer, with recorded replies for both models. Token counts and prices are real-world shaped; the answers are synthetic.

This is a deliberate choice, and it has a cost: these are not live-benchmark numbers, and no live benchmark would reproduce them exactly. What it buys is that anyone who clones the repository gets the same table, for free, in under a second — and that the table is produced by the package rather than typed into the README by hand.

What would move the numbers on your corpus:

- the price ratio between your two models (16× here),
- how often your cheap model is wrong (16% here),
- how much of that is *detectable* — the ceiling on what any ladder can recover,
- how many of your documents have no text layer at all.

## API

### `createLadder(options)`

| Option | Meaning |
|---|---|
| `fast`, `strong` | `{ name, call }`. The name keys pricing and reporting. |
| `escalateWhen` | Checks in order; the first to object supplies the reason. |
| `pricing` | Per-million-token prices. Validated at construction — a ladder that cannot cost its calls throws before it runs one. |
| `budget` | Optional. Without it, every refused answer is paid to re-run. |
| `onSpend` | Called once per run, including runs that cost nothing. |

### `run(input): Promise<LadderOutcome<T>>`

Never throws for an expected state — including a provider that fails, a budget counter that is unreachable, and an `onSpend` that throws. `attempts[]` carries the per-call token usage, cost and duration; `costUsd` is the run total. When something did throw, the error travels on the outcome and on the `SpendRecord` rather than being swallowed: a run that degraded for an unknown cause is a run nobody can fix.

## When you don't need this

- **One model is good enough.** Then use it. A ladder over a model that rarely fails is machinery in exchange for noise.
- **You cannot tell good answers from bad ones.** Without a signal there is nothing to trigger on, and the ladder silently becomes "cheap model only". Fix detection first.
- **Latency matters more than money.** An escalation doubles the wall-clock time for that document.
- **Your models cost about the same.** At a 2× ratio, the arithmetic stops being interesting.

## Not included

- **Retries.** Different concern, different backoff, and mixing them produces a system where nobody can say why a call happened. `unavailable` is the hand-off point.
- **Prompt routing.** Picking a prompt per document type is a different problem than deciding an answer is not good enough.
- **More than two rungs.** Supportable, but the second escalation earns much less than the first and doubles the worst case. Open an issue if you have data that says otherwise.
- **A provider client.** Models are functions. Bring your own.

## Running it

```bash
npm install
npm test          # 19 tests, no network
npm run fixtures  # regenerate the corpus from the seed
npm run simulate  # print the table above
```

## License

MIT
