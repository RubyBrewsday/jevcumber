import { afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
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

  describe('at mobile width', () => {
    let browser: Browser;
    afterAll(() => browser?.close());

    it('does not overflow horizontally at 375px', async () => {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.setViewportSize({ width: 375, height: 800 });
      await page.setContent(html);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);
    });
  });
});
