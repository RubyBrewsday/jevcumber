import type { Page } from '@playwright/test';
import { toLocator } from './locators.js';
import type { ElementInfo, LocatorSpec, Snapshot } from './types.js';

const MAX_TEXT = 8000;

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

  return { title: document.title, text: clean(document.body?.innerText), elements };
}

function specsFor(raw: RawElement): LocatorSpec[] {
  const specs: LocatorSpec[] = [];
  if (raw.testId) specs.push({ by: 'testid', value: raw.testId });
  // Password fields: skip the role locator. Some Playwright/browser combinations compute
  // an accessible role of "textbox" for input[type=password] (contrary to the no-role
  // assumption in this module's design), which would otherwise let a role+name locator
  // resolve uniquely and match a sensitive field. Fall straight through to label/placeholder/text.
  if (raw.name && !raw.sensitive) specs.push({ by: 'role', role: raw.role, name: raw.name });
  if (raw.label) specs.push({ by: 'label', value: raw.label });
  if (raw.placeholder) specs.push({ by: 'placeholder', value: raw.placeholder });
  if (raw.text) specs.push({ by: 'text', value: raw.text });
  return specs;
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const raw = await page.evaluate(collect);

  const located = await Promise.all(
    raw.elements.map(async (element) => {
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

  return { url: page.url(), title: raw.title, elements, text: raw.text.slice(0, MAX_TEXT) };
}
