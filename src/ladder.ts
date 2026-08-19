import { costOf, priceFor, round6, type PricingTable } from "./pricing.js";
import { firstReason } from "./triggers.js";
import type {
  Attempt,
  EscalationBudget,
  EscalationCheck,
  LadderOutcome,
  ModelReply,
  ModelSpec,
  SpendRecord,
} from "./types.js";

export interface LadderOptions<TInput, T> {
  /** Tried first, on every input. */
  fast: ModelSpec<TInput, T>;
  /** Tried at most once, and only when a check asks for it. */
  strong: ModelSpec<TInput, T>;
  /** Checks run in order; the first one to object decides the reason. */
  escalateWhen: Array<EscalationCheck<TInput, T>>;
  pricing: PricingTable;
  /** Optional cap on escalations. Without it, every refused answer is paid to re-run. */
  budget?: EscalationBudget;
  /** Called once per run with the full cost record. */
  onSpend?: (record: SpendRecord) => void;
}

export interface Ladder<TInput, T> {
  run(input: TInput): Promise<LadderOutcome<T>>;
}

export function createLadder<TInput, T>(
  options: LadderOptions<TInput, T>,
): Ladder<TInput, T> {
  const { fast, strong, escalateWhen, pricing, budget, onSpend } = options;

  // Fail on startup, not on the first document: a ladder that cannot cost its
  // own calls is worse than no ladder, because the bill arrives anyway.
  const fastPrice = priceFor(pricing, fast.name);
  const strongPrice = priceFor(pricing, strong.name);

  async function run(input: TInput): Promise<LadderOutcome<T>> {
    const attempts: Attempt[] = [];

    let fastReply: ModelReply<T>;
    try {
      fastReply = await timed(fast.call, input, fast.name, fastPrice, attempts);
    } catch (error) {
      // The cheap model never answered. Nothing is known about this input, so
      // there is no answer to improve on — escalating here would pay the
      // expensive model to find out that the network is broken.
      return finish({
        status: "unavailable",
        error,
        attempts,
        costUsd: total(attempts),
      });
    }

    const reason = firstReason(escalateWhen, fastReply, input);
    if (!reason) {
      return finish({
        status: "fast",
        value: fastReply.value,
        attempts,
        costUsd: total(attempts),
      });
    }

    // One rung, once. A chain of escalations multiplies the bill quietly, and
    // the second re-read almost never rescues a document the first one missed.
    if (budget) {
      let granted: boolean;
      try {
        granted = await budget.take();
      } catch (error) {
        // The counter is unreachable, so whether there is budget left is
        // unknown — and not knowing is never a reason to spend more. The
        // counter usually lives in a database, and a database blip must cost
        // certainty, not the document.
        return finish({
          status: "degraded",
          value: fastReply.value,
          reason,
          cause: "budget",
          error,
          attempts,
          costUsd: total(attempts),
        });
      }

      if (!granted) {
        return finish({
          status: "degraded",
          value: fastReply.value,
          reason,
          cause: "budget",
          attempts,
          costUsd: total(attempts),
        });
      }
    }

    try {
      const strongReply = await timed(
        strong.call,
        input,
        strong.name,
        strongPrice,
        attempts,
      );
      return finish({
        status: "escalated",
        value: strongReply.value,
        reason,
        attempts,
        costUsd: total(attempts),
      });
    } catch (error) {
      // The strong model was unreachable, but the cheap answer still exists and
      // is usable — just less certain. Throwing here would turn "we are less
      // sure about this one" into "we lost this document".
      //
      // The error travels with the outcome rather than being swallowed: a
      // caller that cannot see the provider's own message cannot tell a
      // timeout from a rejected key.
      //
      // The budget unit is deliberately NOT given back: whether a failed call
      // is billable depends on the provider, and a package that guesses will
      // guess wrong in someone's favour. Hand the run to `onSpend` and let the
      // application decide.
      return finish({
        status: "degraded",
        value: fastReply.value,
        reason,
        cause: "provider",
        error,
        attempts,
        costUsd: total(attempts),
      });
    }
  }

  function finish(outcome: LadderOutcome<T>): LadderOutcome<T> {
    try {
      onSpend?.({
        status: outcome.status,
        costUsd: outcome.costUsd,
        attempts: outcome.attempts,
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
        ...("error" in outcome ? { error: outcome.error } : {}),
      });
    } catch (error) {
      // Reporting is not the job. A metrics sink that throws must not cost the
      // caller a document that has already been paid for — and must not vanish
      // either, or the first thing lost is the accounting it was added for.
      console.error("[model-ladder] onSpend threw and was ignored:", error);
    }
    return outcome;
  }

  return { run };
}

async function timed<TInput, T>(
  call: ModelSpec<TInput, T>["call"],
  input: TInput,
  model: string,
  price: { inputPer1M: number; outputPer1M: number },
  attempts: Attempt[],
): Promise<ModelReply<T>> {
  const startedAt = Date.now();
  const reply = await call(input);
  attempts.push({
    model,
    usage: reply.usage,
    costUsd: costOf(reply.usage, price),
    durationMs: Date.now() - startedAt,
  });
  return reply;
}

function total(attempts: Attempt[]): number {
  return round6(attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0));
}
