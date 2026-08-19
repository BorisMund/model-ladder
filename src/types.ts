/** Tokens one call consumed. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why a reply ended. `length` means it was cut off, which is worth escalating. */
export type StopReason = "end" | "length" | "refusal";

/** What a model call gives back, already parsed into your shape. */
export interface ModelReply<T> {
  value: T;
  usage: TokenUsage;
  stopReason?: StopReason;
}

/**
 * A model is just a function you call with your input. Providers, prompts and
 * retries stay in your code, and the tests here need no network.
 */
export type ModelCall<TInput, T> = (input: TInput) => Promise<ModelReply<T>>;

/** The name is what pricing and reports key on. */
export interface ModelSpec<TInput, T> {
  name: string;
  call: ModelCall<TInput, T>;
}

/** Why the cheap answer was refused. A code, so you can group by it later. */
export interface EscalationReason {
  code: string;
  detail?: string;
}

/**
 * Returns a reason to escalate, or null to accept the cheap answer.
 *
 * Synchronous on purpose: a check that hits a database or another model is a
 * second pipeline, and belongs outside this one.
 */
export type EscalationCheck<TInput, T> = (
  reply: ModelReply<T>,
  input: TInput,
) => EscalationReason | null;

/**
 * Permission to spend on one escalation. `take` returns false when the budget
 * is gone. One method, so the counter can live wherever yours already does;
 * see the README for a Postgres version.
 */
export interface EscalationBudget {
  take(): Promise<boolean>;
}

/** One call that happened, and what it cost. */
export interface Attempt {
  model: string;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
}

/** Emitted for every finished run. Feed it to your metrics. */
export interface SpendRecord {
  status: LadderStatus;
  costUsd: number;
  attempts: Attempt[];
  reason?: EscalationReason;
  /** Whatever a provider or the budget counter threw, if anything did. */
  error?: unknown;
}

export type LadderStatus = "fast" | "escalated" | "degraded" | "unavailable";

export type DegradeCause = "budget" | "provider";

/**
 * The result of one run. A union rather than a value plus flags: `degraded`
 * carries a reason and `unavailable` has no value at all.
 */
export type LadderOutcome<T> =
  /** The cheap model answered and no check objected. The common case. */
  | { status: "fast"; value: T; attempts: Attempt[]; costUsd: number }
  /** A check objected, and the strong model answered. */
  | {
      status: "escalated";
      value: T;
      reason: EscalationReason;
      attempts: Attempt[];
      costUsd: number;
    }
  /**
   * A check objected, but the strong model was out of reach: no budget, or the
   * call failed. You get the cheap answer and the reason it was doubted.
   */
  | {
      status: "degraded";
      value: T;
      reason: EscalationReason;
      cause: DegradeCause;
      /** What threw. Absent when the budget was simply spent. */
      error?: unknown;
      attempts: Attempt[];
      costUsd: number;
    }
  /**
   * The cheap model never answered, so there is nothing to return. Not an
   * escalation: a provider being down is a reason to retry, not to pay more.
   */
  | { status: "unavailable"; error: unknown; attempts: Attempt[]; costUsd: number };
