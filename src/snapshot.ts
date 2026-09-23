import type { Page } from '@playwright/test';
import { toLocator } from './locators.js';
import { mostRelevant } from './relevance.js';
import type { ElementInfo, EvidenceItem, LocatorSpec, Snapshot } from './types.js';

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
  // Whether each locator kind, if built from this element's own testId/role+name/label/
  // placeholder/text, would resolve uniquely — computed in-page so at most one Playwright
  // round trip (the chosen spec's own count()) is spent per candidate element.
  unique: { testid?: boolean; role?: boolean; label?: boolean; placeholder?: boolean; text?: boolean };
}

// Runs inside the page: must be self-contained (no references to module scope).
function collect(): { title: string; text: string; elements: RawElement[]; headings: string[] } {
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
    if (type === 'file') return 'file';
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
    if (isFormControl(el) && el.labels?.length) {
      // A wrapping <label>Priority <select>…</select></label> must not include the control's own
      // text (option labels, textarea content): that is not what Playwright's getByLabel matches.
      const label = el.labels[0].cloneNode(true) as HTMLElement;
      label.querySelectorAll('select, textarea, input').forEach((control) => control.remove());
      return clean(label.textContent);
    }
    return '';
  };

  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  };

  // Two passes over the same SELECTOR-matched elements (visible or not, disabled or not): the
  // first computes every candidate's role/name/label/placeholder/text and tallies how many
  // elements would share each locator's key, mirroring what Playwright's getBy* would count.
  // Text/role counting is intentionally scoped to SELECTOR matches rather than the whole
  // document (which is what getByText/getByRole actually scan): a wrong "unique" guess just
  // costs snapshotOnce one extra count() round trip via its fallback loop, never a correctness
  // bug, since the chosen spec is always re-verified against the real page.
  const all = Array.from(document.querySelectorAll(SELECTOR));
  const parsed = all.map((el) => {
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
    const testId = el.getAttribute('data-testid') ?? undefined;
    return { el, type, isInputButton, label, placeholder, text, name, testId, role: roleOf(el) };
  });

  const bump = (map: Map<string, number>, key: string | undefined) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const testidCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  const placeholderCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  for (const p of parsed) {
    // testid/label/placeholder/text locators (getByTestId/getByLabel/getByPlaceholder/getByText)
    // match hidden elements too, so they're tallied over every SELECTOR match regardless of
    // visibility. getByRole, in contrast, ignores hidden elements entirely (though it does still
    // match disabled ones) — so a hidden duplicate must never count against a visible control's
    // role+name uniqueness, or that visible control would wrongly be treated as ambiguous and
    // dropped from the snapshot even though Playwright's own getByRole would resolve it uniquely.
    bump(testidCounts, p.testId);
    bump(labelCounts, p.label || undefined);
    bump(placeholderCounts, p.placeholder || undefined);
    bump(textCounts, p.text || undefined);
    if (p.name && visible(p.el)) bump(roleCounts, `${p.role}:${p.name}`);
  }

  const elements: RawElement[] = [];
  for (const p of parsed) {
    const { el } = p;
    if (!visible(el)) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (!p.name && !p.testId) continue;

    let value: string | undefined;
    if (p.type === 'checkbox' || p.type === 'radio') {
      value = (el as HTMLInputElement).checked ? 'checked' : 'unchecked';
    } else if (el.tagName === 'SELECT') {
      value = clean((el as HTMLSelectElement).selectedOptions[0]?.textContent);
    } else if (isFormControl(el) && p.type !== 'password' && p.type !== 'file' && !p.isInputButton) {
      value = el.value || undefined;
    }

    elements.push({
      role: p.role,
      name: p.name,
      value,
      testId: p.testId,
      label: p.label || undefined,
      placeholder: p.placeholder || undefined,
      text: p.text || undefined,
      // TODO: only password inputs are treated as sensitive; other sensitive inputs (e.g.
      // autocomplete="cc-number") still send their values in the snapshot.
      sensitive: p.type === 'password' || undefined,
      unique: {
        testid: p.testId ? testidCounts.get(p.testId) === 1 : undefined,
        role: p.name ? roleCounts.get(`${p.role}:${p.name}`) === 1 : undefined,
        label: p.label ? labelCounts.get(p.label) === 1 : undefined,
        placeholder: p.placeholder ? placeholderCounts.get(p.placeholder) === 1 : undefined,
        text: p.text ? textCounts.get(p.text) === 1 : undefined,
      },
    });
  }

  // Site chrome (menus, sidebars, tables of contents) can fill the whole text budget before the
  // content starts, so read the main landmark when the page has one.
  const content = document.querySelector<HTMLElement>('main, [role=main], article') ?? document.body;
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .filter((h) => visible(h))
    .map((h) => clean((h as HTMLElement).innerText))
    .filter(Boolean);
  return { title: document.title, text: clean(content?.innerText), elements, headings };
}

// Only specs whose in-page uniqueness held are returned, in preference order, so snapshotOnce
// spends at most one Playwright count() round trip verifying the first (and, on the rare
// disagreement between this in-page computation and Playwright's own, a second on the next).
function specsFor(raw: RawElement): LocatorSpec[] {
  const specs: LocatorSpec[] = [];
  if (raw.testId && raw.unique.testid) specs.push({ by: 'testid', value: raw.testId });
  // Password fields: skip the role locator. Some Playwright/browser combinations compute
  // an accessible role of "textbox" for input[type=password] (contrary to the no-role
  // assumption in this module's design), which would otherwise let a role+name locator
  // resolve uniquely and match a sensitive field. Fall straight through to label/placeholder/text.
  // getByRole('file') never matches: a file input has no such accessible role in Playwright/ARIA.
  if (raw.name && !raw.sensitive && raw.role !== 'file' && raw.unique.role) specs.push({ by: 'role', role: raw.role, name: raw.name });
  if (raw.label && raw.unique.label) specs.push({ by: 'label', value: raw.label });
  if (raw.placeholder && raw.unique.placeholder) specs.push({ by: 'placeholder', value: raw.placeholder });
  if (raw.text && raw.unique.text) specs.push({ by: 'text', value: raw.text });
  return specs;
}

const MAX_EVIDENCE = 40;
const MAX_EVIDENCE_LENGTH = 80;

// Things a described expectation could be pinned to: what the page says it is about. Only the
// title and headings are ever pinned to (see executor.ts); links and buttons are still sent as
// evidence because they can settle which item best shows the expectation, or serve as a
// page-sourced input_text candidate, without being pin-worthy themselves.
function evidenceOf(raw: { title: string; headings: string[]; elements: RawElement[] }, relevantTo: string): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const title = raw.title.trim().slice(0, MAX_EVIDENCE_LENGTH);
  if (title) items.push({ text: title, kind: 'title' });
  for (const heading of raw.headings) {
    const text = heading.trim();
    // Dropped rather than truncated: a truncated heading would not `getByRole('heading', {
    // name, exact: true })` back to itself, so a pin on it could never replay.
    if (!text || text.length > MAX_EVIDENCE_LENGTH) continue;
    items.push({ text, kind: 'heading' });
  }
  for (const element of raw.elements) {
    if (element.role !== 'link' && element.role !== 'button') continue;
    const text = element.name.trim().slice(0, MAX_EVIDENCE_LENGTH);
    if (!text) continue;
    items.push({ text, kind: element.role });
  }
  // Dedupe by text; the first occurrence (title, then headings, then links/buttons) wins the kind.
  const byText = new Map<string, EvidenceItem>();
  for (const item of items) if (!byText.has(item.text)) byText.set(item.text, item);
  // Title and headings win ties, so a described expectation prefers pin-worthy evidence.
  return mostRelevant([...byText.values()], relevantTo, (item) => item.text, MAX_EVIDENCE, (item) => item.kind === 'title' || item.kind === 'heading');
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
  const evidence = evidenceOf(raw, options.relevantTo ?? '');
  if (options.elements === false) return { url: page.url(), title: raw.title, elements: [], text, evidence };

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
      for (const spec of specsFor(element)) {
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

  return { url: page.url(), title: raw.title, elements, text, evidence };
}
