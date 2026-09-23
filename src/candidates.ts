import type { Step } from './types.js';

export const QUOTED = /"([^"]+)"|(?<!\w)'([^']+)'(?!\w)/g;
// A bare literal is a URL, a host (domain, localhost, or IPv4 — but not the domain of an email address),
// a /path, or a number.
const BARE =
  /https?:\/\/\S+|(?<![@\w.-])(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/\S*)?|(?<=^|\s)\/[\w\-./]*|\b\d+(?:\.\d+)?\b/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/** Literal values a step could want typed, opened, or checked for, in order of appearance. */
export function extractValues(step: Step): string[] {
  const found: { index: number; value: string }[] = [];

  // Blank out quoted spans (same length, so indices line up) before scanning for bare literals.
  const unquoted = step.text.replace(QUOTED, (match, double, single, index: number) => {
    found.push({ index, value: double ?? single });
    return ' '.repeat(match.length);
  });
  for (const match of unquoted.matchAll(BARE)) {
    found.push({ index: match.index, value: match[0].replace(TRAILING_PUNCTUATION, '') });
  }

  const values = found.sort((a, b) => a.index - b.index).map((entry) => entry.value);
  if (step.table) values.push(...step.table.flat());
  if (step.docString) values.push(step.docString);
  return [...new Set(values.filter((value) => value.length > 0))];
}
