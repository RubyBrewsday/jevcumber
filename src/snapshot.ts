import type { Page } from '@playwright/test';
import { toLocator } from './locators.js';
import { mostRelevant } from './relevance.js';
import type { ElementInfo, LocatorSpec, Snapshot } from './types.js';

const MAX_TEXT = 8000;
// Verifying a locator costs browser round-trips, and a page can have thousands of links (a long
// Wikipedia article has ~7 000). Jev is only ever shown the 60 most relevant elements, so only the
// most relevant candidates are verified at all.
const MAX_CANDIDATES = 80;

export interface SnapshotOptions {
  /** The step being resolved: candidates are ranked by the words they share with it. */
  relevantTo?: string;
  /** Pass false when only the page's url, title, and text are needed. */
  elements?: boolean;
}

interface RawElement {
  role: string;
  name: string;
  value?: string;
  testId?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  sensitive?: boolean;
}

// Runs inside the page: must be self-contained (no references to module scope).
function collect(): { title: string; text: string; elements: RawElement[] } {
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=switch]', '[role=combobox]', '[role=textbox]',
  ].join(',');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    return 'textbox';
  };

  const isFormControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase());

  const labelOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => clean(document.getElementById(id)?.textContent)).join(' ');
      if (clean(text)) return clean(text);
    }
    if (isFormControl(el) && el.labels?.length) return clean(el.labels[0].textContent);
    return '';
  };

  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  };

  const elements: RawElement[] = [];
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (!visible(el)) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const isInputButton = el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
    const label = labelOf(el);
    const placeholder = clean(el.getAttribute('placeholder'));
    const text = isFormControl(el) ? '' : clean((el as HTMLElement).innerText);
    const name =
      clean(el.getAttribute('aria-label')) ||
      label ||
      (isInputButton ? clean((el as HTMLInputElement).value) : '') ||
      text ||
      clean(el.querySelector('img')?.getAttribute('alt')) ||
      clean(el.getAttribute('title')) ||
      placeholder;
    if (!name && !el.getAttribute('data-testid')) continue;

    let value: string | undefined;
    if (type === 'checkbox' || type === 'radio') {
      value = (el as HTMLInputElement).checked ? 'checked' : 'unchecked';
    } else if (el.tagName === 'SELECT') {
      value = clean((el as HTMLSelectElement).selectedOptions[0]?.textContent);
    } else if (isFormControl(el) && type !== 'password' && !isInputButton) {
      value = el.value || undefined;
    }

    elements.push({
      role: roleOf(el),
      name,
      value,
      testId: el.getAttribute('data-testid') ?? undefined,
      label: label || undefined,
      placeholder: placeholder || undefined,
      text: text || undefined,
      // TODO: only password inputs are treated as sensitive; other sensitive inputs (e.g.
      // autocomplete="cc-number") still send their values in the snapshot.
      sensitive: type === 'password' || undefined,
    });
  }

  // Site chrome (menus, sidebars, tables of contents) can fill the whole text budget before the
  // content starts, so read the main landmark when the page has one.
  const content = document.querySelector<HTMLElement>('main, [role=main], article') ?? document.body;
  return { title: document.title, text: clean(content?.innerText), elements };
}

// `repeated` holds role+name and text keys that occur more than once on the page: those locators
// cannot be unique, so they are not worth a round-trip.
function specsFor(raw: RawElement, repeated: Set<string>): LocatorSpec[] {
  const specs: LocatorSpec[] = [];
  if (raw.testId) specs.push({ by: 'testid', value: raw.testId });
  // Password fields: skip the role locator. Some Playwright/browser combinations compute
  // an accessible role of "textbox" for input[type=password] (contrary to the no-role
  // assumption in this module's design), which would otherwise let a role+name locator
  // resolve uniquely and match a sensitive field. Fall straight through to label/placeholder/text.
  if (raw.name && !raw.sensitive && !repeated.has(roleKey(raw))) specs.push({ by: 'role', role: raw.role, name: raw.name });
  if (raw.label) specs.push({ by: 'label', value: raw.label });
  if (raw.placeholder) specs.push({ by: 'placeholder', value: raw.placeholder });
  if (raw.text && !repeated.has(textKey(raw))) specs.push({ by: 'text', value: raw.text });
  return specs;
}

const roleKey = (raw: RawElement) => `role:${raw.role}:${raw.name}`;
const textKey = (raw: RawElement) => `text:${raw.text}`;

function repeatedKeys(elements: RawElement[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const element of elements) {
    for (const key of [roleKey(element), textKey(element)]) {
      if (seen.has(key)) repeated.add(key);
      seen.add(key);
    }
  }
  return repeated;
}

const NAVIGATION_RETRIES = 5;

// An action such as submitting a search can still be navigating when the next step starts:
// wait for the document, and start over if a navigation pulls the page out from under us.
export async function snapshot(page: Page, options: SnapshotOptions = {}): Promise<Snapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded');
      return await snapshotOnce(page, options);
    } catch (error) {
      const interrupted = error instanceof Error && /context was destroyed|navigat/i.test(error.message);
      if (!interrupted || attempt >= NAVIGATION_RETRIES) throw error;
    }
  }
}

async function snapshotOnce(page: Page, options: SnapshotOptions): Promise<Snapshot> {
  const raw = await page.evaluate(collect);
  const text = raw.text.slice(0, MAX_TEXT);
  if (options.elements === false) return { url: page.url(), title: raw.title, elements: [], text, evidence: [] };

  const repeated = repeatedKeys(raw.elements);
  // On a page of links, controls (fields, buttons) are the likelier targets: they win ties.
  const candidates = mostRelevant(
    raw.elements,
    options.relevantTo ?? '',
    (element) => `${element.role} ${element.name}`,
    MAX_CANDIDATES,
    (element) => element.role !== 'link',
  );

  const located = await Promise.all(
    candidates.map(async (element) => {
      for (const spec of specsFor(element, repeated)) {
        if ((await toLocator(page, spec).count()) === 1) return { element, spec };
      }
      return undefined; // not uniquely locatable: better omitted than ambiguous
    }),
  );

  const elements: ElementInfo[] = [];
  for (const entry of located) {
    if (!entry) continue;
    const info: ElementInfo = {
      id: `e${elements.length + 1}`,
      role: entry.element.role,
      name: entry.element.name,
      locator: entry.spec,
    };
    if (entry.element.value !== undefined) info.value = entry.element.value;
    elements.push(info);
  }

  return { url: page.url(), title: raw.title, elements, text, evidence: [] };
}
