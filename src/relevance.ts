const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/**
 * The `max` items sharing the most words with `text`, returned in their original order.
 * Ties go to items `prefer` picks out, then to whichever came first.
 */
export function mostRelevant<T>(
  items: T[],
  text: string,
  describe: (item: T) => string,
  max: number,
  prefer: (item: T) => boolean = () => false,
): T[] {
  if (items.length <= max) return items;
  const wanted = tokens(text);
  const scored = items.map((item, index) => {
    let overlap = 0;
    for (const token of tokens(describe(item))) if (wanted.has(token)) overlap++;
    return { item, index, overlap, preferred: prefer(item) ? 1 : 0 };
  });
  return scored
    .sort((a, b) => b.overlap - a.overlap || b.preferred - a.preferred || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);
}
