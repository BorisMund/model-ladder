# model-ladder

[![CI](https://github.com/BorisMund/model-ladder/actions/workflows/ci.yml/badge.svg)](https://github.com/BorisMund/model-ladder/actions/workflows/ci.yml)

Ask the cheap model first. Pay for the strong one only when the cheap answer fails a check, under a budget, with a cost record for every call.

## The numbers

500 documents, three strategies, same corpus:

| Strategy | Cost per 1000 documents | Correct vendor |
|---|---|---|
| Cheap model only | $3.71 | 84.2% |
| Strong model only | $59.74 | 97.4% |
| **Ladder** | **$13.53** | **97.2%** |

77% cheaper than always using the strong model, for 0.2 points of accuracy.

16.8% of documents escalated. What asked for it:

| Reason | Documents |
|---|---|
| `ungrounded`: the vendor is nowhere in the document text | 41 |
| `missing-fields`: a required field came back empty | 26 |
| `truncated`: the answer hit the token limit | 17 |

`npm run simulate` reproduces the table. The corpus is recorded rather than live; see [Where the numbers come from](#where-the-numbers-come-from).

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
  case "fast":        return outcome.value;                       // the common case
  case "escalated":   return outcome.value;                       // paid for, and worth it
  case "degraded":    return flag(outcome.value, outcome.reason); // usable, less certain
  case "unavailable": throw outcome.error;                        // nothing is known
}
```

Zero runtime dependencies. Models are functions you pass in, so the tests run without a network or an API key.

## The arithmetic

The strong model costs 16x the cheap one on this corpus ($0.0597 against $0.0037), so the bill comes down to how many documents reach it:

```
cost per document = cheap + escalation_rate * strong
```

Two things follow. The escalation rate is the only knob that matters: double it and you nearly double the bill. And the ladder stays cheaper until 94% of documents escalate, since break-even is `1 - cheap/strong`. Even a badly tuned ladder rarely loses to always-strong, it just stops winning much.

The real risk runs the other way. If your cheap model is wrong in ways your checks cannot see, you get the cheap price and the cheap accuracy plus a layer of machinery. That is why every check returns a code and every run goes through `onSpend`: an escalation rate of 3% should show up on your dashboard, not on your invoice.

## Checks

Plain functions returning a reason or `null`. Four ship with the package:

| Check | Escalates when |
|---|---|
| `whenTruncated()` | The provider says the answer hit the token limit. |
| `whenFieldsMissing([...])` | A required field came back empty. |
| `whenInvalid(validate)` | Your validator rejected the shape. Wrap zod's `safeParse` and pass it. |
| `whenUngrounded({ field, sourceText })` | A field that should appear verbatim in the document does not appear at all. |

`whenUngrounded` does most of the work, 41 of the 84 escalations above, and has the most edge cases:

- **No text layer means skip, not escalate.** There is nothing to compare against, and escalating every photo would just make the strong model your default. A fifth of the corpus is photos, and they cost the cheap price.
- **Legal suffixes and case are normalised away.** `ACME Corp.` against a header reading `ACME CORPORATION` is the same company. Without this, half the corpus escalates for nothing.
- **Letter-spaced headings are glued back together.** PDF text layers produce `A C M E` routinely. `G l o b e x   I n d u s t r i e s` also loses its word boundary, so the comparison is tried a second time with all spaces removed.
- **Names too short to ground are left alone.** One letter appears in almost any document.
- **Only verbatim fields work.** Totals (`1 234,56` vs `1234.56`) and dates get reformatted, so grounding them produces false alarms.

## What the ladder will not do

1. **Escalate when the cheap model itself failed.** The run ends as `unavailable` and the strong model is never called. Paying 16x to discover the network is down helps nobody; retries are the caller's job.
2. **Escalate twice.** One rung, no chains. A second re-read rarely rescues a document the first one missed, and chains multiply the bill quietly.
3. **Fail when the budget is gone or unreachable.** You get the cheap answer with its reason attached, as `degraded`. Losing the document would be the worse outcome.

## Budget

`budget` is one method, `take(): Promise<boolean>`, so the counter lives wherever your counters already live:

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

[quota-slot](https://github.com/BorisMund/quota-slot) does that atomically, which matters here: ten attachments from one email escalate at the same time, and a read-then-write counter overshoots the budget. It is not a dependency, though. Five lines of glue beats coupling two packages.

## Where the numbers come from

`scripts/generate-fixtures.ts` builds the corpus from a fixed seed: 500 documents, 104 of them without a text layer, with recorded replies for both models. Token counts and prices are real-world shaped; the answers are synthetic.

The trade is worth stating. These are not live-benchmark numbers, and no live benchmark would reproduce them exactly. In exchange, anyone who clones the repository gets the same table in under a second, and that table comes out of the package instead of being typed into this file by hand.

On your corpus the numbers move with the price ratio between your models (16x here), how often the cheap one is wrong (16%), how much of that your checks can actually detect, and how many documents have no text layer.

## API

### `createLadder(options)`

| Option | Meaning |
|---|---|
| `fast`, `strong` | `{ name, call }`. The name keys pricing and reporting. |
| `escalateWhen` | Checks in order; the first to object supplies the reason. |
| `pricing` | Per-million-token prices. Validated at construction, so a ladder that cannot cost its calls throws before it runs one. |
| `budget` | Optional. Without it, every refused answer is paid to re-run. |
| `onSpend` | Called once per run, including runs that cost nothing. |

### `run(input): Promise<LadderOutcome<T>>`

Never throws for an expected state, including a provider that fails, a budget counter that is unreachable, and an `onSpend` that throws. `attempts[]` carries the per-call token usage, cost and duration; `costUsd` is the run total. Anything that did throw travels on the outcome and on the `SpendRecord` rather than being swallowed.

## Limits

Skip this package if one model is already good enough, or if you cannot tell a good answer from a bad one. Without a signal to trigger on, the ladder quietly becomes "cheap model only", so fix detection first. Skip it too when latency matters more than money, since an escalation doubles wall-clock time for that document, or when your two models cost about the same.

Left out on purpose:

- **Retries.** Different concern, different backoff. `unavailable` is the hand-off point.
- **Prompt routing.** Choosing a prompt per document type is a different problem from deciding an answer is not good enough.
- **A third rung.** The second escalation earns much less than the first and doubles the worst case. Open an issue if you have data that says otherwise.
- **A provider client.** Models are functions, bring your own.

## Running it

```bash
npm install
npm test          # 19 tests, no network
npm run fixtures  # regenerate the corpus from the seed
npm run simulate  # print the table above
```

## License

MIT
