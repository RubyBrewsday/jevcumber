import { describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, availableParallelism: () => 16 };
});

import { defaultWorkers } from '../src/cli.js';

describe('defaultWorkers', () => {
  it('uses the full CPU count under --frozen (no Jev calls, just replaying the lockfile)', () => {
    expect(defaultWorkers('frozen')).toBe(16);
  });

  it('caps at 4 for a live run, since Jev has its own rate limits', () => {
    expect(defaultWorkers('default')).toBe(4);
    expect(defaultWorkers('update')).toBe(4);
  });
});
