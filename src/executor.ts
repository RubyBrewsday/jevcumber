import { expect, type Locator, type Page } from '@playwright/test';
import { toLocator } from './locators.js';
import type { Judgment } from './resolver.js';
import type { Assertion, ExecuteResult, LocatorSpec, ResolvedStep } from './types.js';

export const SEMANTIC_THRESHOLD = 0.8;
// A majority is enough: pins are already restricted to the title and headings, and a title and an h1
// that say the same thing legitimately split the probability between them.
export const PIN_MIN_CONFIDENCE = 0.5;
const ASSERT_TIMEOUT = 5000;
// Try selecting by visible label first (what a step's literal usually names); fall back to the
// option's value for cases like <option value="fr">Republique</option>. The label attempt gets a
// short timeout so a value-only step doesn't pay the full default timeout before falling back.
const SELECT_LABEL_TIMEOUT = 1000;

export interface ExecuteContext {
  /** What relative navigation resolves against. Optional: steps may name full URLs instead. */
  baseUrl?: string;
  stepText: string;
  /** Judges whether the page satisfies stepText. Absent in --frozen mode. */
  judge?: (stepText: string) => Promise<Judgment>;
}

/** Locators the runner should validate before replaying a cached step. Assertions are left to expect's auto-wait. */
export function actionLocators(resolved: ResolvedStep): LocatorSpec[] {
  if (resolved.kind === 'navigate' || resolved.kind === 'assert') return [];
  return resolved.locator ? [resolved.locator] : [];
}

const LOCAL_HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/|$)/i;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Where a navigate step's literal points: a full URL, a bare host, or a path under the base URL. */
export function navigationUrl(value: string, baseUrl?: string): string {
  if (LOCAL_HOST.test(value)) return new URL(`http://${value}`).href;
  if (DOMAIN.test(value)) return new URL(`https://${value}`).href;
  if (HAS_SCHEME.test(value)) return new URL(value).href;
  if (!baseUrl) {
    throw new Error(`"${value}" is a relative path, but no --base-url was given. Use a full URL in the step, or pass --base-url.`);
  }
  return new URL(value, baseUrl).href;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Let the page react to the action so the next snapshot sees its settled state.
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {});
}

async function select(locator: Locator, value: string): Promise<void> {
  try {
    await locator.selectOption({ label: value }, { timeout: SELECT_LABEL_TIMEOUT });
  } catch (labelError) {
    try {
      await locator.selectOption({ value });
    } catch {
      throw labelError;
    }
  }
}

async function check(page: Page, assertion: Assertion, ctx: ExecuteContext): Promise<ExecuteResult> {
  const timeout = ASSERT_TIMEOUT;
  switch (assertion.form) {
    case 'text_visible':
      await expect(page.getByText(assertion.value, { exact: assertion.pinned }).first()).toBeVisible({ timeout });
      return {};
    case 'text_not_visible':
      await expect(page.getByText(assertion.value).first()).toBeHidden({ timeout });
      return {};
    case 'title_contains':
      await expect(page).toHaveTitle(new RegExp(escapeRegExp(assertion.value)), { timeout });
      return {};
    case 'heading_visible':
      await expect(page.getByRole('heading', { name: assertion.value, exact: true }).first()).toBeVisible({ timeout });
      return {};
    case 'url_contains':
      await expect(page).toHaveURL(new RegExp(escapeRegExp(assertion.value)), { timeout });
      return {};
    case 'element_visible':
      await expect(toLocator(page, assertion.locator)).toBeVisible({ timeout });
      return {};
    case 'element_has_value':
      await expect(toLocator(page, assertion.locator)).toHaveValue(assertion.value, { timeout });
      return {};
    case 'semantic': {
      if (!ctx.judge) {
        throw new Error('This step is a descriptive expectation that only Jev can judge, so it cannot run with --frozen.');
      }
      const judgment = await ctx.judge(ctx.stepText);
      if (judgment.holds < SEMANTIC_THRESHOLD) {
        throw new Error(`Jev judged the expectation unmet (p=${judgment.holds.toFixed(2)}, needs ≥ ${SEMANTIC_THRESHOLD}).`);
      }
      // Pin to concrete evidence so later runs can replay this step without Jev — but only when
      // it's the page title or a heading (a link or button name is not something a Then step is
      // really "about"), and only if that evidence is really there, or the pinned check would
      // fail on the very next run.
      if (judgment.evidence && (judgment.evidenceConfidence ?? 0) >= PIN_MIN_CONFIDENCE) {
        if (judgment.evidenceKind === 'title') {
          if ((await page.title()).includes(judgment.evidence)) {
            return { pinned: { form: 'title_contains', value: judgment.evidence, pinned: true }, confidence: judgment.evidenceConfidence };
          }
        } else if (judgment.evidenceKind === 'heading') {
          const visible = await page.getByRole('heading', { name: judgment.evidence, exact: true }).first().isVisible().catch(() => false);
          if (visible) return { pinned: { form: 'heading_visible', value: judgment.evidence, pinned: true }, confidence: judgment.evidenceConfidence };
        }
      }
      return {};
    }
    default: {
      const unreachable: never = assertion;
      throw new Error(`Unhandled assertion form: ${JSON.stringify(unreachable)}`);
    }
  }
}

export async function execute(page: Page, resolved: ResolvedStep, ctx: ExecuteContext): Promise<ExecuteResult> {
  switch (resolved.kind) {
    case 'navigate':
      await page.goto(navigationUrl(resolved.value, ctx.baseUrl));
      break;
    case 'click':
      await toLocator(page, resolved.locator).click();
      break;
    case 'check':
      await toLocator(page, resolved.locator).check();
      break;
    case 'uncheck':
      await toLocator(page, resolved.locator).uncheck();
      break;
    case 'fill': {
      const field = toLocator(page, resolved.locator);
      await field.fill(resolved.value);
      if (resolved.submit) await field.press('Enter');
      break;
    }
    case 'select':
      await select(toLocator(page, resolved.locator), resolved.value);
      break;
    case 'press':
      if (resolved.locator) await toLocator(page, resolved.locator).press(resolved.key);
      else await page.keyboard.press(resolved.key);
      break;
    case 'assert':
      return check(page, resolved.assertion, ctx);
    default: {
      const unreachable: never = resolved;
      throw new Error(`Unhandled resolved step kind: ${JSON.stringify(unreachable)}`);
    }
  }
  await settle(page);
  return {};
}
