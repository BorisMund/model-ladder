import type { EscalationCheck, EscalationReason, ModelReply } from "./types.js";

/**
 * Ready-made escalation checks. All of them look only at the reply, never at a
 * network or a database — see the note on EscalationCheck for why.
 */

/** The answer was cut off by the token limit, so it is incomplete by definition. */
export function whenTruncated<TInput, T>(): EscalationCheck<TInput, T> {
  return (reply) =>
    reply.stopReason === "length"
      ? { code: "truncated", detail: "stop reason was `length`" }
      : null;
}

/** A field the caller needs came back empty. */
export function whenFieldsMissing<TInput, T extends object>(
  fields: Array<keyof T & string>,
): EscalationCheck<TInput, T> {
  return (reply) => {
    const missing = fields.filter((field) => isEmpty(reply.value[field]));
    return missing.length > 0
      ? { code: "missing-fields", detail: missing.join(", ") }
      : null;
  };
}

/** Your own validator rejected the shape. Pass zod's safeParse, or anything else. */
export function whenInvalid<TInput, T>(
  validate: (value: T) => { ok: boolean; detail?: string },
): EscalationCheck<TInput, T> {
  return (reply) => {
    const result = validate(reply.value);
    if (result.ok) {
      return null;
    }
    return result.detail === undefined
      ? { code: "schema-miss" }
      : { code: "schema-miss", detail: result.detail };
  };
}

/**
 * The strongest signal in practice: a field that should appear verbatim in the
 * source document does not appear there at all.
 *
 * A model that reads a company name off a logo — or invents one — produces a
 * plausible string that is nowhere in the text. That is worth paying to
 * re-check. A field that merely looks odd is not.
 *
 * Two deliberate limits:
 *   - documents with no extractable text (photos, scans) are skipped, not
 *     escalated. There is nothing to compare against, and escalating all of
 *     them is not a rare fallback — it is changing the default model, at the
 *     default model's price.
 *   - only fields that appear verbatim can be checked this way. Totals are
 *     formatted (1 234,56 vs 1234.56) and dates are reformatted almost always,
 *     so grounding them produces false alarms, not signal.
 */
export function whenUngrounded<TInput, T extends object>(options: {
  field: keyof T & string;
  /** Text extracted from the source. Empty or missing means "cannot check". */
  sourceText: (input: TInput) => string | null | undefined;
}): EscalationCheck<TInput, T> {
  return (reply, input) => {
    const claimed = reply.value[options.field];
    if (typeof claimed !== "string" || claimed.trim() === "") {
      return null; // absence is `missing-fields`, not a fabrication
    }

    const text = options.sourceText(input);
    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      return null; // no text layer: nothing to compare against
    }

    return contains(text, claimed)
      ? null
      : { code: "ungrounded", detail: `${options.field}="${claimed}" is not in the source text` };
  };
}

/** Below this, a "text layer" is page furniture, not content. */
const MIN_TEXT_LENGTH = 40;

/**
 * Legal suffixes are the single biggest source of false alarms: the header says
 * ACME CORPORATION and the model answers "ACME Corp." Both name the same
 * company, and treating that as a fabrication would escalate half the corpus.
 */
const LEGAL_SUFFIXES = [
  "corporation", "corp", "incorporated", "inc", "limited", "ltd", "llc", "llp",
  "gmbh", "ag", "bv", "nv", "oy", "ab", "as", "sa", "srl", "spa", "plc", "pte",
];

/** Below this, a claim is a substring of almost any document. */
const MIN_CLAIM_LENGTH = 2;

function contains(haystack: string, needle: string): boolean {
  const text = normalize(haystack);
  const claim = normalize(needle);

  // A claim too short to verify is not evidence of a fabrication: one letter
  // appears in nearly every document, so escalating on it buys noise. Absence
  // of a real name is `missing-fields`, which runs before this check.
  if (claim.length < MIN_CLAIM_LENGTH) {
    return true;
  }

  if (text.includes(claim)) {
    return true;
  }

  // Letter-spaced headings lose their word boundaries as well as their letter
  // ones: `Globex Industries` extracts as `G l o b e x   I n d u s t r i e s`,
  // which glues back to one token and never matches a two-word claim. Compare
  // the space-free forms as well, so a spaced heading grounds a spaced name.
  return spaceFree(text).includes(spaceFree(claim));
}

function spaceFree(value: string): string {
  return value.replace(/ /g, "");
}

/**
 * Normalisation for text-layer noise, not for prettiness. PDF extraction gives
 * back hyphenated line breaks, soft hyphens, non-breaking spaces and letter-
 * spaced headings (`A C M E`), none of which survive a naive `includes`.
 */
export function normalize(value: string): string {
  const flattened = value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/­/g, "") // soft hyphen
    .replace(/-\s*\n\s*/g, "") // hyphenation across a line break
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  const words = flattened
    .split(" ")
    .filter((word) => word.length > 0 && !LEGAL_SUFFIXES.includes(word));

  // Letter-spaced headings arrive as single characters; glue them back so
  // "a c m e" and "acme" compare equal. A run of one is kept as it is rather
  // than dropped: deleting it would erase the whole of a name like "E Corp",
  // whose only surviving token is a single letter.
  const glued: string[] = [];
  let run = "";
  for (const word of words) {
    if (word.length === 1) {
      run += word;
      continue;
    }
    if (run.length > 0) {
      glued.push(run);
      run = "";
    }
    glued.push(word);
  }
  if (run.length > 0) {
    glued.push(run);
  }

  return glued.join(" ");
}

/** Run checks in order and return the first reason, or null. */
export function firstReason<TInput, T>(
  checks: Array<EscalationCheck<TInput, T>>,
  reply: ModelReply<T>,
  input: TInput,
): EscalationReason | null {
  for (const check of checks) {
    const reason = check(reply, input);
    if (reason) {
      return reason;
    }
  }
  return null;
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}
