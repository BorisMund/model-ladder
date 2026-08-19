import type { EscalationCheck, EscalationReason, ModelReply } from "./types.js";

/** Ready-made checks. All of them look only at the reply, never at the network. */

/** The answer hit the token limit, so it is incomplete. */
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

/** Your validator rejected the shape. Wrap zod's safeParse, or anything else. */
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
 * document is nowhere in it. A model reading a company name off a logo, or
 * inventing one, produces a plausible string with no source behind it.
 *
 * Only works for verbatim fields. Totals (1 234,56 vs 1234.56) and dates get
 * reformatted, so grounding those gives false alarms rather than signal.
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

/** Below this, the "text layer" is page furniture rather than content. */
const MIN_TEXT_LENGTH = 40;

/** Dropped from both sides: "ACME Corp." and "ACME CORPORATION" are one company. */
const LEGAL_SUFFIXES = [
  "corporation", "corp", "incorporated", "inc", "limited", "ltd", "llc", "llp",
  "gmbh", "ag", "bv", "nv", "oy", "ab", "as", "sa", "srl", "spa", "plc", "pte",
];

/** Below this, a claim is a substring of almost any document. */
const MIN_CLAIM_LENGTH = 2;

function contains(haystack: string, needle: string): boolean {
  const text = normalize(haystack);
  const claim = normalize(needle);

  // One letter is a substring of almost any document, so it proves nothing.
  // A genuinely empty field is `missing-fields`, which runs before this check.
  if (claim.length < MIN_CLAIM_LENGTH) {
    return true;
  }

  if (text.includes(claim)) {
    return true;
  }

  // Letter-spacing loses word boundaries too: `Globex Industries` extracts as
  // `G l o b e x   I n d u s t r i e s`, which glues back into one token and
  // never matches a two-word claim.
  return spaceFree(text).includes(spaceFree(claim));
}

function spaceFree(value: string): string {
  return value.replace(/ /g, "");
}

/**
 * Strips the noise PDF extraction adds: soft hyphens, hyphenated line breaks,
 * accents, punctuation and letter-spaced headings (`A C M E`), none of which
 * survive a naive `includes`.
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

  // Glue runs of single characters back together, so "a c m e" matches "acme".
  // A run of one is kept: it may be all that survives of a name like "E Corp".
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
