import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { snapshot } from '../src/snapshot.js';
import { toLocator } from '../src/locators.js';

const HTML = `
<title>Fixture</title>
<h1>Sign in</h1>
<form>
  <label for="email">Email</label> <input id="email" type="email" value="pre@fill.ed">
  <label>Password <input type="password" value="hunter2"></label>
  <input placeholder="Search…" type="search">
  <label><input type="checkbox" checked> Remember me</label>
  <select aria-label="Country"><option>UK</option><option selected>France</option></select>
  <button data-testid="submit-btn">Log in</button>
  <button>Delete</button> <button>Delete</button>
  <button disabled>Disabled one</button>
  <button style="display:none">Hidden one</button>
  <a href="/help">Need help?</a>
</form>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(() => browser.close());

describe('snapshot', () => {
  it('captures title and visible text', async () => {
    const snap = await snapshot(page);
    expect(snap.title).toBe('Fixture');
    expect(snap.text).toContain('Sign in');
  });

  it('lists interactive elements with sequential ids, roles, and names', async () => {
    const { elements } = await snapshot(page);
    expect(elements.map((e) => e.id)).toEqual(elements.map((_, i) => `e${i + 1}`));
    const byName = Object.fromEntries(elements.map((e) => [e.name, e]));
    expect(byName['Email']).toMatchObject({ role: 'textbox', value: 'pre@fill.ed' });
    expect(byName['Log in'].locator).toEqual({ by: 'testid', value: 'submit-btn' });
    expect(byName['Need help?']).toMatchObject({ role: 'link', locator: { by: 'role', role: 'link', name: 'Need help?' } });
    expect(byName['Remember me']).toMatchObject({ role: 'checkbox', value: 'checked' });
    expect(byName['Country']).toMatchObject({ role: 'combobox', value: 'France' });
    expect(byName['Search…'].locator).toMatchObject({ by: 'role' });
  });

  it('falls through to the label locator for password inputs and never exposes their value', async () => {
    const { elements } = await snapshot(page);
    const password = elements.find((e) => e.name === 'Password')!;
    expect(password.locator).toEqual({ by: 'label', value: 'Password' });
    expect(password.value).toBeUndefined();
  });

  it('omits disabled, hidden, and non-uniquely-locatable elements', async () => {
    const names = (await snapshot(page)).elements.map((e) => e.name);
    expect(names).not.toContain('Disabled one');
    expect(names).not.toContain('Hidden one');
    expect(names).not.toContain('Delete');
  });

  it('produces locators that each resolve to exactly one element', async () => {
    for (const element of (await snapshot(page)).elements) {
      expect(await toLocator(page, element.locator).count(), element.name).toBe(1);
    }
  });

  it('truncates page text to 8000 characters', async () => {
    const long = await browser.newPage();
    await long.setContent(`<p>${'word '.repeat(5000)}</p>`);
    expect((await snapshot(long)).text.length).toBe(8000);
    await long.close();
  });

  it('retries when a navigation destroys the page context mid-snapshot', async () => {
    let failures = 2;
    const flaky = new Proxy(page, {
      get(target, property, receiver) {
        if (property === 'evaluate' && failures > 0) {
          return async () => {
            failures--;
            throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await snapshot(flaky)).title).toBe('Fixture');
    expect(failures).toBe(0);
  });

  it('does not retry other errors', async () => {
    const broken = new Proxy(page, {
      get(target, property, receiver) {
        if (property === 'evaluate') return async () => { throw new Error('boom'); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(snapshot(broken)).rejects.toThrow('boom');
  });

  describe('on a very large page', () => {
    let big: Page;
    beforeAll(async () => {
      big = await browser.newPage();
      const links = Array.from({ length: 4000 }, (_, i) => `<a href="/p${i}">Article number ${i}</a>`).join(' ');
      await big.setContent(`<title>Big</title>${links}<form><input aria-label="Search the archive" type="search"><button>Go</button></form>`);
    });
    afterAll(() => big.close());

    it('stays fast by verifying only the elements most relevant to the step', async () => {
      const started = Date.now();
      const snap = await snapshot(big, { relevantTo: 'When I search for "cats"' });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(snap.elements.length).toBeLessThanOrEqual(80);
      expect(snap.elements.map((e) => e.name)).toContain('Search the archive');
    });

    it('keeps form controls ahead of the sea of links even when nothing in the step matches', async () => {
      const names = (await snapshot(big, { relevantTo: 'When I do the thing' })).elements.map((e) => e.name);
      expect(names).toContain('Search the archive');
      expect(names).toContain('Go');
    });

    it('skips element collection entirely when only the page text is wanted', async () => {
      const snap = await snapshot(big, { elements: false });
      expect(snap.elements).toEqual([]);
      expect(snap.title).toBe('Big');
      expect(snap.text).toContain('Article number 1');
    });
  });

  it('reads page text from the main content when the page marks one, not from the site chrome', async () => {
    const framed = await browser.newPage();
    await framed.setContent(`<title>T</title><nav>Main menu Donate Log in ${'Sidebar link '.repeat(900)}</nav>
      <main><h1>Michelle Obama</h1><p>An American attorney and author.</p></main><footer>Privacy policy</footer>`);
    const snap = await snapshot(framed, { elements: false });
    expect(snap.text.startsWith('Michelle Obama')).toBe(true);
    expect(snap.text).not.toContain('Sidebar link');
    await framed.close();
  });

  it('falls back to the whole body when there is no main content landmark', async () => {
    expect((await snapshot(page, { elements: false })).text).toContain('Sign in');
  });
});
