import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { actionLocators, execute, navigationUrl } from '../src/executor.js';
import type { LocatorSpec } from '../src/types.js';

const HTML = `
<label for="email">Email</label><input id="email">
<label><input type="checkbox"> Remember me</label>
<select aria-label="Country"><option>UK</option><option>France</option><option value="fr">Republique</option></select>
<button onclick="document.getElementById('out').textContent = 'Clicked!'">Go</button>
<input aria-label="Search" onkeydown="if (event.key === 'Enter') document.getElementById('out').textContent = 'Searched'">
<input type="file" aria-label="Photo">
<div id="far" style="margin-top:3000px">Far away</div>
<button onmouseover="document.getElementById('out').textContent='Hovered'">Hover me</button>
<p id="out"></p>
<p style="display:none">Secret</p>`;

const role = (r: string, name: string): LocatorSpec => ({ by: 'role', role: r, name });
const ctx = { baseUrl: 'http://unused', stepText: 'step' };

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(2000);
});
beforeEach(() => page.setContent(HTML));
afterAll(() => browser.close());

describe('execute: actions', () => {
  it('fills, checks, unchecks, selects, clicks, and presses', async () => {
    await execute(page, { kind: 'fill', locator: role('textbox', 'Email'), value: 'a@b.c' }, ctx);
    expect(await page.getByLabel('Email').inputValue()).toBe('a@b.c');

    await execute(page, { kind: 'check', locator: role('checkbox', 'Remember me') }, ctx);
    expect(await page.getByRole('checkbox').isChecked()).toBe(true);
    await execute(page, { kind: 'uncheck', locator: role('checkbox', 'Remember me') }, ctx);
    expect(await page.getByRole('checkbox').isChecked()).toBe(false);

    await execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: 'France' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('France');

    // No option is labelled "fr": falls back to selecting by option value.
    await execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: 'fr' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('fr');

    await execute(page, { kind: 'click', locator: role('button', 'Go') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Clicked!');

    await execute(page, { kind: 'press', key: 'Enter', locator: role('textbox', 'Search') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Searched');
  });

  it('passes absolute navigation URLs through unchanged', async () => {
    await execute(page, { kind: 'navigate', value: 'about:blank' }, { ...ctx, baseUrl: 'http://localhost:1' });
    expect(page.url()).toBe('about:blank');
  });
});

  it('presses Enter after filling when the step is marked submit', async () => {
    await execute(page, { kind: 'fill', locator: role('textbox', 'Search'), value: 'bagels', submit: true }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Searched');
    expect(await page.getByLabel('Search').inputValue()).toBe('bagels');
  });

  it('hovers, clears, scrolls, uploads, and waits', async () => {
    await execute(page, { kind: 'hover', locator: role('button', 'Hover me') }, ctx);
    expect(await page.locator('#out').textContent()).toBe('Hovered');

    await page.getByLabel('Email').fill('x');
    await execute(page, { kind: 'clear', locator: role('textbox', 'Email') }, ctx);
    expect(await page.getByLabel('Email').inputValue()).toBe('');

    await execute(page, { kind: 'scroll', locator: { by: 'text', value: 'Far away' } }, ctx);
    expect(await page.locator('#far').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-upload-'));
    writeFileSync(join(dir, 'photo.png'), 'not really a png');
    await execute(page, { kind: 'upload', locator: { by: 'label', value: 'Photo' }, value: 'photo.png' }, { ...ctx, featureDir: dir });
    expect(await page.getByLabel('Photo').evaluate((el) => (el as HTMLInputElement).files?.[0]?.name)).toBe('photo.png');

    const started = Date.now();
    await execute(page, { kind: 'wait', seconds: 1 }, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await execute(page, { kind: 'wait' }, ctx);
    setTimeout(() => page.evaluate(() => (document.getElementById('out')!.textContent = 'Later')), 300);
    await execute(page, { kind: 'wait', text: 'Later' }, ctx);
  });

  it('selects by 1-based index when no label or value matches', async () => {
    // Country: 1=UK, 2=France, 3=Republique (value "fr").
    await execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: '2' }, ctx);
    expect(await page.getByRole('combobox').inputValue()).toBe('France');
  });

  it('throws a message listing the options when nothing matches label, value, or index', async () => {
    await expect(
      execute(page, { kind: 'select', locator: role('combobox', 'Country'), value: 'Germany' }, ctx),
    ).rejects.toThrow('No option labelled or valued "Germany" (options: UK, France, Republique)');
  });

describe('execute: assertions', () => {
  it('passes and fails text_visible', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Email' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Nope' } }, ctx),
    ).rejects.toThrow();
  });

  it('treats hidden or absent text as not visible', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Secret' } }, ctx);
    await execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Absent' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'text_not_visible', value: 'Email' } }, ctx),
    ).rejects.toThrow();
  });

  it('checks element visibility, element value, and URL', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'element_visible', locator: role('button', 'Go') } }, ctx);
    await page.getByLabel('Email').fill('x@y.z');
    await execute(page, { kind: 'assert', assertion: { form: 'element_has_value', locator: role('textbox', 'Email'), value: 'x@y.z' } }, ctx);
    await execute(page, { kind: 'assert', assertion: { form: 'url_contains', value: 'about:blank' } }, ctx);
    await expect(
      execute(page, { kind: 'assert', assertion: { form: 'url_contains', value: '/todos' } }, ctx),
    ).rejects.toThrow();
  });

  it('judges described expectations against the 0.8 threshold', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    expect(await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9 }) })).toEqual({});
    await expect(execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.5 }) })).rejects.toThrow(/0\.50/);
    await expect(execute(page, semantic, ctx)).rejects.toThrow(/--frozen/);
  });

  it('pins title evidence as a title check', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    await page.setContent('<title>Bagel - Wikipedia</title><h1>Bagel</h1>');
    const judge = async () => ({ holds: 0.95, evidence: 'Bagel - Wikipedia', evidenceKind: 'title' as const, evidenceConfidence: 0.8 });
    expect(await execute(page, semantic, { ...ctx, judge })).toEqual({
      pinned: { form: 'title_contains', value: 'Bagel - Wikipedia', pinned: true }, confidence: 0.8,
    });
    await execute(page, { kind: 'assert', assertion: { form: 'title_contains', value: 'Bagel - Wikipedia', pinned: true } }, ctx);
    await expect(execute(page, { kind: 'assert', assertion: { form: 'title_contains', value: 'Nope' } }, ctx)).rejects.toThrow();
  });

  it('pins heading evidence as a heading_visible check, but only when it is actually visible and confident enough', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    await page.setContent('<title>T</title><h1>Bagel</h1>');
    const pinned = await execute(page, semantic, {
      ...ctx,
      judge: async () => ({ holds: 0.9, evidence: 'Bagel', evidenceKind: 'heading', evidenceConfidence: 0.8 }),
    });
    expect(pinned).toEqual({ pinned: { form: 'heading_visible', value: 'Bagel', pinned: true }, confidence: 0.8 });
    // Below PIN_MIN_CONFIDENCE: not pinned.
    expect(
      await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Bagel', evidenceKind: 'heading', evidenceConfidence: 0.4 }) }),
    ).toEqual({});
    // Not actually a heading on the page: not pinned.
    expect(
      await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Missing', evidenceKind: 'heading', evidenceConfidence: 0.9 }) }),
    ).toEqual({});
  });

  it('never pins link or button evidence', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    expect(
      await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Go', evidenceKind: 'link', evidenceConfidence: 0.9 }) }),
    ).toEqual({});
    expect(
      await execute(page, semantic, { ...ctx, judge: async () => ({ holds: 0.9, evidence: 'Go', evidenceKind: 'button', evidenceConfidence: 0.9 }) }),
    ).toEqual({});
  });

  it('replays a pinned text_visible assertion (an older lockfile) as a plain text check', async () => {
    await execute(page, { kind: 'assert', assertion: { form: 'text_visible', value: 'Email', pinned: true } }, ctx);
  });

  it('replays a pinned heading_visible assertion, and fails when the heading is gone', async () => {
    await page.setContent('<title>T</title><h1>Bagel</h1>');
    await execute(page, { kind: 'assert', assertion: { form: 'heading_visible', value: 'Bagel' } }, ctx);
    await expect(execute(page, { kind: 'assert', assertion: { form: 'heading_visible', value: 'Nope' } }, ctx)).rejects.toThrow();
  });
});

describe('actionLocators', () => {
  it('returns locators for actions only', () => {
    expect(actionLocators({ kind: 'click', locator: role('button', 'Go') })).toEqual([role('button', 'Go')]);
    expect(actionLocators({ kind: 'press', key: 'Enter' })).toEqual([]);
    expect(actionLocators({ kind: 'navigate', value: '/' })).toEqual([]);
    expect(actionLocators({ kind: 'assert', assertion: { form: 'element_visible', locator: role('button', 'Go') } })).toEqual([]);
    expect(actionLocators({ kind: 'hover', locator: role('button', 'Go') })).toEqual([role('button', 'Go')]);
    expect(actionLocators({ kind: 'wait' })).toEqual([]);
  });
});

describe('navigationUrl', () => {
  it('passes absolute URLs through, with or without a base URL', () => {
    expect(navigationUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(navigationUrl('https://example.com/a', 'http://localhost:3000')).toBe('https://example.com/a');
  });

  it('assumes https for a bare domain and http for localhost', () => {
    expect(navigationUrl('example.com/pricing')).toBe('https://example.com/pricing');
    expect(navigationUrl('localhost:3000/login')).toBe('http://localhost:3000/login');
    expect(navigationUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
  });

  it('resolves paths against the base URL', () => {
    expect(navigationUrl('/login', 'http://localhost:3000')).toBe('http://localhost:3000/login');
  });

  it('explains what to do when a path has no base URL to resolve against', () => {
    expect(() => navigationUrl('/login')).toThrow(/--base-url/);
  });
});
