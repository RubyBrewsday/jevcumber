import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { actionLocators, execute } from '../src/executor.js';
import type { LocatorSpec } from '../src/types.js';

const HTML = `
<label for="email">Email</label><input id="email">
<label><input type="checkbox"> Remember me</label>
<select aria-label="Country"><option>UK</option><option>France</option></select>
<button onclick="document.getElementById('out').textContent = 'Clicked!'">Go</button>
<input aria-label="Search" onkeydown="if (event.key === 'Enter') document.getElementById('out').textContent = 'Searched'">
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

  it('judges semantic assertions against the 0.8 threshold', async () => {
    const semantic = { kind: 'assert', assertion: { form: 'semantic' } } as const;
    await execute(page, semantic, { ...ctx, semantic: async () => 0.85 });
    await expect(execute(page, semantic, { ...ctx, semantic: async () => 0.5 })).rejects.toThrow(/0\.50/);
    await expect(execute(page, semantic, ctx)).rejects.toThrow(/--frozen/);
  });
});

describe('actionLocators', () => {
  it('returns locators for actions only', () => {
    expect(actionLocators({ kind: 'click', locator: role('button', 'Go') })).toEqual([role('button', 'Go')]);
    expect(actionLocators({ kind: 'press', key: 'Enter' })).toEqual([]);
    expect(actionLocators({ kind: 'navigate', value: '/' })).toEqual([]);
    expect(actionLocators({ kind: 'assert', assertion: { form: 'element_visible', locator: role('button', 'Go') } })).toEqual([]);
  });
});
