import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/app/server.js';
import { main } from '../src/cli.js';

// Calls the real Jev API: runs only when a key is available.
describe.skipIf(!process.env.TYPESAFE_API_KEY)('jevcumber live against the fixture app', () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(() => server.close());

  it('resolves every step with Jev, writes a lockfile, then replays it frozen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcumber-live-'));
    cpSync('fixtures/features', dir, { recursive: true });

    expect(await main([dir, '--base-url', server.url])).toBe(0);
    expect(existsSync(join(dir, 'login.feature.lock.json'))).toBe(true);
    expect(await main([dir, '--base-url', server.url, '--frozen'])).toBe(0);
  }, 180_000);
});
