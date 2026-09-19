import type { Locator, Page } from '@playwright/test';
import type { LocatorSpec } from './types.js';

type Role = Parameters<Page['getByRole']>[0];

export function toLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'testid':
      return page.getByTestId(spec.value);
    case 'role':
      return page.getByRole(spec.role as Role, { name: spec.name, exact: true });
    case 'label':
      return page.getByLabel(spec.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(spec.value, { exact: true });
    case 'text':
      return page.getByText(spec.value, { exact: true });
  }
}
