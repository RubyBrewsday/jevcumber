#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { consoleReporter, exitCode } from './reporter.js';
import { runAll } from './runner.js';
import type { Mode } from './types.js';

function parseConfidence(raw: string): number {
  const value = Number(raw);
  if (!(value >= 0 && value <= 1)) throw new InvalidArgumentError('must be a number between 0 and 1');
  return value;
}

function parseBaseUrl(raw: string): string {
  try {
    new URL(raw);
  } catch {
    throw new InvalidArgumentError('must be an absolute URL, e.g. http://localhost:3000');
  }
  return raw;
}

export async function main(argv: string[]): Promise<number> {
  const program = new Command()
    .name('jevcumber')
    .description('Run Cucumber feature files against a web UI with no step definitions.')
    .argument('<paths...>', 'feature files or directories')
    .option('--base-url <url>', 'URL that relative paths in steps resolve against (not needed when steps use full URLs)', parseBaseUrl)
    .option('--frozen', 'replay the lockfile only; never call Jev (for CI)', false)
    .option('--update', 'ignore the lockfile and re-resolve every step', false)
    .option('--headed', 'show the browser', false)
    .option('--min-confidence <n>', 'refuse to act below this Jev confidence', parseConfidence, 0.6)
    .option('--tags <expr>', 'cucumber tag expression, e.g. "@smoke and not @wip"')
    .exitOverride();

  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    // commander has already printed the message (or the help text)
    return (error as { exitCode?: number }).exitCode ?? 1;
  }

  const options = program.opts();
  if (options.frozen && options.update) {
    console.error('error: --frozen and --update are mutually exclusive');
    return 1;
  }
  const mode: Mode = options.frozen ? 'frozen' : options.update ? 'update' : 'default';

  try {
    const results = await runAll({
      paths: program.args,
      baseUrl: options.baseUrl,
      mode,
      headed: options.headed,
      minConfidence: options.minConfidence,
      tags: options.tags,
      reporter: consoleReporter(),
    });
    if (results.length === 0) {
      console.error('error: no scenarios found');
      return 1;
    }
    return exitCode(results);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run only when invoked as a script (npm's bin shim is a symlink, hence realpath).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
