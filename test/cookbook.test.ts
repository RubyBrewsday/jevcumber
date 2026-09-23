import { describe, expect, it } from 'vitest';
import { buildCookbook } from '../scripts/cookbook.js';

describe('buildCookbook', () => {
  const html = buildCookbook();

  it('has the page title', () => {
    expect(html).toContain('<title>jevcumber cookbook');
  });

  it('has a section heading for fill', () => {
    expect(html).toMatch(/<h2>[^<]*[Ff]ill[^<]*<\/h2>/);
  });

  it('includes the wikipedia search-and-submit row', () => {
    expect(html).toContain('I search for &quot;bagel&quot;');
    expect(html).toContain('then press Enter');
  });

  it('has a section for wait', () => {
    expect(html).toMatch(/<h2>[^<]*[Ww]ait[^<]*<\/h2>/);
  });

  it('has no duplicate rows', () => {
    const rows = [...html.matchAll(/<tr><td>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
    expect(new Set(rows).size).toBe(rows.length);
  });
});
