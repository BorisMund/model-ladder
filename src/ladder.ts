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
  /** Run in order; the first to object supplies the reason. */
  escalateWhen: Array<EscalationCheck<TInput, T>>;
  pricing: PricingTable;
  /** Optional. Without it, every refused answer is paid to re-run. */
  budget?: EscalationBudget;
  /** Called once per run, whatever the outcome. */
  onSpend?: (record: SpendRecord) => void;
}

export interface Ladder<TInput, T> {
  run(input: TInput): Promise<LadderOutcome<T>>;
}

export function createLadder<TInput, T>(
  options: LadderOptions<TInput, T>,
): Ladder<TInput, T> {
  const { fast, strong, escalateWhen, pricing, budget, onSpend } = options;

  // Throw on startup rather than on the first document.
  const fastPrice = priceFor(pricing, fast.name);
  const strongPrice = priceFor(pricing, strong.name);

  async function run(input: TInput): Promise<LadderOutcome<T>> {
    const attempts: Attempt[] = [];
    let fastReply: ModelReply<T>;
    try {
      // fastReply = await timed(fast.call, input, fast.name, fastPrice, attempts);
      fastReply = await timed(fast.call, input, fast.name, fastPrice, attempts);
    } catch (error) {
      // Nothing is known about this input yet, so there is no answer to
      // improve on. Escalating would just pay the strong model to hit the
      // same broken network.
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

    if (budget) {
      let granted: boolean;
      try {
        granted = await budget.take();
      } catch (error) {
        // The counter is usually a database, and it is unreachable, so the
        // remaining budget is unknown. Degrade rather than spend on a guess.
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

    // One rung only. Chains of escalations multiply the bill, and a second
    // re-read rarely rescues a document the first one missed.
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
      // The cheap answer still exists and is usable, just less certain, so
      // hand it back with the provider's error attached.
      //
      // The budget unit is not given back: whether a failed call is billable
      // depends on the provider, so leave that call to the application.
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
      // A broken metrics sink must not cost the caller a document that was
      // already paid for. Log it rather than swallow it.
      console.error("[llm-ladder] onSpend threw and was ignored:", error);
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
