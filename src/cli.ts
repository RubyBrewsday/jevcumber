#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { findConfigFile, loadConfig } from './config.js';
import { explain } from './explain.js';
import { exitCode } from './reporter.js';
import { createReporters, type ReporterName } from './reporters/index.js';
import { runAll } from './runner.js';
import type { Mode } from './types.js';

const VERSION: string = createRequire(import.meta.url)('../package.json').version;

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

function parseWorkers(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new InvalidArgumentError('must be a positive integer');
  return value;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// The CPU count on its own is a fine default under --frozen (no calls to Jev, just replaying the
// lockfile as fast as the machine can). A live run additionally caps at 4: Jev has its own rate
// limits, and more workers than that mostly just queues up concurrent resolve() calls against it.
// runAll further caps whatever this returns at the scenario count, once it knows it.
export function defaultWorkers(mode: Mode): number {
  const cpu = availableParallelism();
  return mode === 'frozen' ? cpu : Math.min(cpu, 4);
}

// Installs the browser build that matches the Playwright bundled with jevcumber; a stray
// `npx playwright install` can fetch a different Playwright and with it the wrong build.
function installBrowser(extraArgs: string[]): number {
  const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium', ...extraArgs], { stdio: 'inherit' });
  return result.status ?? 1;
}

// Prints, for every scenario step, what its lockfile entry resolves to (no browser, no API).
async function runExplain(args: string[]): Promise<number> {
  const sub = new Command()
    .name('jevcumber explain')
    .argument('<paths...>', 'feature files or directories')
    .option('--tags <expr>', 'cucumber tag expression, e.g. "@smoke and not @wip"')
    .exitOverride();
  try {
    sub.parse(args, { from: 'user' });
  } catch (error) {
    return (error as { exitCode?: number }).exitCode ?? 1;
  }
  try {
    // Same precedence as the main run: an explicit --tags wins; otherwise fall back to the
    // nearest jevcumber.config.js/.mjs found walking up from the cwd.
    let tags: string | undefined = sub.opts().tags;
    if (tags === undefined) {
      const config = await loadConfig(findConfigFile(process.cwd()));
      tags = config.tags;
    }
    return explain(sub.args, tags, (line) => console.log(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'install-browser') return installBrowser(argv.slice(1));
  if (argv[0] === 'explain') return await runExplain(argv.slice(1));

  const program = new Command()
    .name('jevcumber')
    .version(VERSION, '-v, --version', 'print the jevcumber version')
    .description('Run Cucumber feature files against a web UI with no step definitions.')
    .argument('<paths...>', 'feature files or directories')
    .option('--base-url <url>', 'URL that relative paths in steps resolve against (not needed when steps use full URLs)', parseBaseUrl)
    .option('--frozen', 'replay the lockfile only; never call Jev (for CI)', false)
    .option('--update', 'ignore the lockfile and re-resolve every step', false)
    .option('--headed', 'show the browser', false)
    .option('--min-confidence <n>', 'refuse to act below this Jev confidence', parseConfidence, 0.6)
    .option('--tags <expr>', 'cucumber tag expression, e.g. "@smoke and not @wip"')
    .option('--report-dir <dir>', 'where screenshots and snapshots of failing steps are written', 'jevcumber-report')
    .option('--no-report', 'do not write failure evidence')
    .option(
      '--trace',
      'record a Playwright trace per scenario; kept under --report-dir for scenarios that did not pass (even with --no-report)',
      false,
    )
    .option(
      '--workers <n>',
      'number of scenarios to run concurrently (default: available CPUs under --frozen, capped at 4 otherwise for Jev\'s rate limits; 1 with --headed)',
      parseWorkers,
    )
    .option('--record-eval <dir>', 'record every Jev exchange (sent, received, outcome) under this directory, for offline reproduction')
    .option('--config <path>', 'path to a jevcumber.config.js/.mjs (default: the nearest one found walking up from cwd)')
    .option('--reporter <name>', 'reporter to use (console, json, junit); repeatable', collect, [] as string[])
    .option('--output <file>', 'output file for the json/junit reporters (default under --report-dir)')
    .addHelpText(
      'after',
      '\nFirst time? Run `jevcumber install-browser` to download the Chromium build jevcumber drives.' +
        '\nRun `jevcumber explain <paths...>` to see what each step\'s lockfile entry resolves to, with no browser.',
    )
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

  let config;
  try {
    const configPath = program.getOptionValueSource('config') === 'cli' ? options.config : findConfigFile(process.cwd());
    config = await loadConfig(configPath);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const fromCli = (name: string) => program.getOptionValueSource(name) === 'cli';
  const baseUrl = fromCli('baseUrl') ? options.baseUrl : (config.baseUrl ?? options.baseUrl);
  const tags = fromCli('tags') ? options.tags : (config.tags ?? options.tags);
  const minConfidence = fromCli('minConfidence') ? options.minConfidence : (config.minConfidence ?? options.minConfidence);
  const reportDir = fromCli('reportDir') ? options.reportDir : (config.reportDir ?? options.reportDir);
  const workers = fromCli('workers') ? options.workers : (config.workers ?? defaultWorkers(mode));

  const KNOWN_REPORTERS = new Set<ReporterName>(['console', 'json', 'junit']);
  const rawReporterNames = (options.reporter.length > 0 ? options.reporter : ['console']) as ReporterName[];
  for (const name of rawReporterNames) {
    if (!KNOWN_REPORTERS.has(name)) {
      // Written directly to process.stderr (not console.error), which binds its stream at
      // startup: a test spying on process.stderr.write to assert on CLI errors would otherwise
      // never see console.error's output.
      process.stderr.write(`error: unknown reporter "${name}" (expected console, json, or junit)\n`);
      return 1;
    }
  }
  // De-duplicate before launching anything: `--reporter json --reporter json` must not write the
  // same file twice (or, worse, be treated as "two file reporters" by the --output check below).
  const reporterNames = [...new Set(rawReporterNames)];
  const fileReporters = reporterNames.filter((name) => name === 'json' || name === 'junit');
  if (options.output && fileReporters.length > 1) {
    process.stderr.write('error: --output applies to a single file reporter; use --report-dir for several\n');
    return 1;
  }
  if (options.output && fileReporters.length === 0) {
    process.stderr.write('warning: --output has no effect without a json or junit reporter\n');
  }

  try {
    const results = await runAll({
      paths: program.args,
      baseUrl,
      mode,
      headed: options.headed,
      minConfidence,
      tags,
      reporter: createReporters(reporterNames, {
        output: options.output,
        reportDir,
        isTTY: process.stderr.isTTY === true,
        writeStatus: (s) => process.stderr.write(s),
      }),
      reportDir,
      report: options.report !== false,
      trace: options.trace,
      workers,
      hooks: config.hooks,
      recordEval: options.recordEval,
    });
    if (results.length === 0) {
      console.error('error: no scenarios found');
      return 1;
    }
    return exitCode(results);
  } catch (error) {
    // A TTY status line (from the console reporter's redraw) can still be sitting on the current
    // line when a run aborts; clear it first so the error below isn't appended after "3/10
    // scenarios · ...". Written directly to process.stderr, like the --reporter/--output errors
    // above, so it's visible to a test spying on process.stderr.write.
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    if (/Executable doesn't exist|playwright install/i.test(message)) {
      process.stderr.write('\nThe browser is not installed yet. Run: jevcumber install-browser\n');
    }
    return 1;
  }
}

// Run only when invoked as a script (npm's bin shim is a symlink, hence realpath).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
