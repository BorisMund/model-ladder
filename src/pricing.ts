import type { TokenUsage } from "./types.js";

/** Price of one model, per million tokens, in whatever currency you report in. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Prices keyed by model name.
 *
 * Configuration, never a constant in the source: list prices change, and a
 * package that hardcodes them starts lying the week after it is published.
 */
export type PricingTable = Record<string, ModelPrice>;

export class MissingPriceError extends Error {
  constructor(model: string) {
    super(
      `No price configured for model "${model}". Every model on the ladder needs one — ` +
        `a run that cannot be costed is a run you cannot budget.`,
    );
    this.name = "MissingPriceError";
  }
}

export function priceFor(pricing: PricingTable, model: string): ModelPrice {
  const price = pricing[model];
  if (!price) {
    throw new MissingPriceError(model);
  }
  return price;
}

/** Cost of one call. Rounded to six places — fractions of a cent add up over a month. */
export function costOf(usage: TokenUsage, price: ModelPrice): number {
  const cost =
    (usage.inputTokens / 1_000_000) * price.inputPer1M +
    (usage.outputTokens / 1_000_000) * price.outputPer1M;
  return round6(cost);
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
