import { expect, type Locator, type Page } from '@playwright/test';
import { toLocator } from './locators.js';
import type { Assertion, LocatorSpec, ResolvedStep } from './types.js';

export const SEMANTIC_THRESHOLD = 0.8;
const ASSERT_TIMEOUT = 5000;
// Try selecting by visible label first (what a step's literal usually names); fall back to the
// option's value for cases like <option value="fr">Republique</option>. The label attempt gets a
// short timeout so a value-only step doesn't pay the full default timeout before falling back.
const SELECT_LABEL_TIMEOUT = 1000;

export interface ExecuteContext {
  /** What relative navigation resolves against. Optional: steps may name full URLs instead. */
  baseUrl?: string;
  stepText: string;
  /** Returns P(page satisfies stepText). Absent in --frozen mode. */
  semantic?: (stepText: string) => Promise<number>;
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

async function check(page: Page, assertion: Assertion, ctx: ExecuteContext): Promise<void> {
  const timeout = ASSERT_TIMEOUT;
  switch (assertion.form) {
    case 'text_visible':
      return expect(page.getByText(assertion.value).first()).toBeVisible({ timeout });
    case 'text_not_visible':
      return expect(page.getByText(assertion.value).first()).toBeHidden({ timeout });
    case 'url_contains':
      return expect(page).toHaveURL(new RegExp(escapeRegExp(assertion.value)), { timeout });
    case 'element_visible':
      return expect(toLocator(page, assertion.locator)).toBeVisible({ timeout });
    case 'element_has_value':
      return expect(toLocator(page, assertion.locator)).toHaveValue(assertion.value, { timeout });
    case 'semantic': {
      if (!ctx.semantic) {
        throw new Error('This step is a descriptive expectation that only Jev can judge, so it cannot run with --frozen.');
      }
      const probability = await ctx.semantic(ctx.stepText);
      if (probability < SEMANTIC_THRESHOLD) {
        throw new Error(`Jev judged the expectation unmet (p=${probability.toFixed(2)}, needs ≥ ${SEMANTIC_THRESHOLD}).`);
      }
      return;
    }
    default: {
      const unreachable: never = assertion;
      throw new Error(`Unhandled assertion form: ${JSON.stringify(unreachable)}`);
    }
  }
}

export async function execute(page: Page, resolved: ResolvedStep, ctx: ExecuteContext): Promise<void> {
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
    case 'fill':
      await toLocator(page, resolved.locator).fill(resolved.value);
      break;
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
}
