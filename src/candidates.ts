import type { Step } from './types.js';

const QUOTED = /"([^"]+)"|(?<!\w)'([^']+)'(?!\w)/g;
const BARE = /https?:\/\/\S+|(?<=^|\s)\/[\w\-./]*|\b\d+(?:\.\d+)?\b/g;

/** Literal values a step could want typed, opened, or checked for, in order of appearance. */
export function extractValues(step: Step): string[] {
  const found: { index: number; value: string }[] = [];

  // Blank out quoted spans (same length, so indices line up) before scanning for bare literals.
  const unquoted = step.text.replace(QUOTED, (match, double, single, index: number) => {
    found.push({ index, value: double ?? single });
    return ' '.repeat(match.length);
  });
  for (const match of unquoted.matchAll(BARE)) {
    found.push({ index: match.index, value: match[0] });
  }

  const values = found.sort((a, b) => a.index - b.index).map((entry) => entry.value);
  if (step.table) values.push(...step.table.flat());
  if (step.docString) values.push(step.docString);
  return [...new Set(values.filter((value) => value.length > 0))];
}
