import { describe, expect, it } from 'vitest';
import { extractValues } from '../src/candidates.js';
import type { Step } from '../src/types.js';

const step = (text: string, extra: Partial<Step> = {}): Step => ({ keyword: 'When', text, ...extra });

describe('extractValues', () => {
  it('extracts double- and single-quoted strings in order', () => {
    expect(extractValues(step(`I fill in "Email" with 'alice@example.com'`))).toEqual(['Email', 'alice@example.com']);
  });

  it('does not treat apostrophes as quotes', () => {
    expect(extractValues(step(`I don't see the user's name`))).toEqual([]);
  });

  it('extracts bare URLs, paths, and numbers outside quotes', () => {
    expect(extractValues(step('I visit https://example.com/a?b=1 then /login and wait 3 seconds'))).toEqual([
      'https://example.com/a?b=1',
      '/login',
      '3',
    ]);
  });

  it('does not re-extract numbers or paths from inside quoted strings', () => {
    expect(extractValues(step('I am on "/login" with code "42"'))).toEqual(['/login', '42']);
  });

  it('appends table cells and the docstring, deduplicated', () => {
    const values = extractValues(step('I add "Buy milk"', { table: [['Buy milk'], ['Walk dog']], docString: 'note' }));
    expect(values).toEqual(['Buy milk', 'Walk dog', 'note']);
  });
});
