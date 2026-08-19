/** Tokens a single call consumed. The only input to the cost of that call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why a reply ended. `length` matters here: a truncated answer is a classic
 * reason to escalate, and it is indistinguishable from a bad answer unless the
 * provider tells you.
 */
export type StopReason = "end" | "length" | "refusal";

/** What a model call gives back, already parsed into your own shape. */
export interface ModelReply<T> {
  value: T;
  usage: TokenUsage;
  stopReason?: StopReason;
}

/**
 * A model, as far as this package is concerned: something you call with your
 * input that returns a reply. Passing a function rather than a client keeps
 * providers, prompts and retries where they belong — in your code — and lets
 * the tests here run without a network or an API key.
 */
export type ModelCall<TInput, T> = (input: TInput) => Promise<ModelReply<T>>;

/** Named model plus the callable. The name is what pricing and reports key on. */
export interface ModelSpec<TInput, T> {
  name: string;
  call: ModelCall<TInput, T>;
}

/**
 * Why the cheap answer was not good enough. A code rather than a boolean,
 * because "escalated" on its own tells you nothing a month later: you need to
 * know whether it was schema misses or truncation to fix the prompt.
 */
export interface EscalationReason {
  code: string;
  detail?: string;
}

/**
 * Decides whether to pay for the strong model. Returns a reason to escalate,
 * or null to accept the cheap answer.
 *
 * Deliberately synchronous: an escalation check that queries a database or
 * calls another model is a second pipeline, and it belongs outside this one.
 */
export type EscalationCheck<TInput, T> = (
  reply: ModelReply<T>,
  input: TInput,
) => EscalationReason | null;

/**
 * Permission to spend on one escalation. `take` returns false when the budget
 * is gone, and the ladder degrades instead of failing.
 *
 * Kept as a one-method interface so this package has no runtime dependencies:
 * the accounting lives wherever your counters already live. See the README for
 * a Postgres-backed implementation.
 */
export interface EscalationBudget {
  take(): Promise<boolean>;
}

/** One call that actually happened, with what it cost. */
export interface Attempt {
  model: string;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
}

/** Emitted for every finished run, whatever the outcome. Feed it to your metrics. */
export interface SpendRecord {
  status: LadderStatus;
  costUsd: number;
  attempts: Attempt[];
  reason?: EscalationReason;
  /**
   * What a provider or the budget counter threw, when something did. Reported
   * rather than swallowed: a run that degraded for an unknown cause is a run
   * nobody can fix.
   */
  error?: unknown;
}

export type LadderStatus = "fast" | "escalated" | "degraded" | "unavailable";

/** Why the ladder stopped one rung short of where it wanted to go. */
export type DegradeCause = "budget" | "provider";

/**
 * The result of one run. A union rather than a value plus flags: "degraded"
 * carries a reason and "unavailable" carries no value at all, and the type
 * should make that impossible to ignore.
 */
export type LadderOutcome<T> =
  /** The cheap model answered and nothing asked for more. The common case. */
  | { status: "fast"; value: T; attempts: Attempt[]; costUsd: number }
  /** The cheap answer was refused, the strong model was paid for and answered. */
  | {
      status: "escalated";
      value: T;
      reason: EscalationReason;
      attempts: Attempt[];
      costUsd: number;
    }
  /**
   * The cheap answer was refused, but the strong model was not reachable —
   * either the budget is spent or the provider failed. The cheap answer is
   * returned anyway: it is a usable result with lower confidence, and dropping
   * it would turn "less certain" into "no answer at all".
   */
  | {
      status: "degraded";
      value: T;
      reason: EscalationReason;
      cause: DegradeCause;
      /**
       * What the strong model or the budget counter threw. Absent for the
       * ordinary case of a budget that is simply spent — that is an answer,
       * not a failure.
       */
      error?: unknown;
      attempts: Attempt[];
      costUsd: number;
    }
  /**
   * The cheap model itself never answered. Nothing is known about the input,
   * so there is no value to return. This is NOT an escalation: a provider that
   * is down is a reason to retry, not a reason to pay more.
   */
  | { status: "unavailable"; error: unknown; attempts: Attempt[]; costUsd: number };
