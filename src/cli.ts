#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { findConfigFile, loadConfig } from './config.js';
import { exitCode } from './reporter.js';
import { createReporters, type ReporterName } from './reporters/index.js';
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

function parseWorkers(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new InvalidArgumentError('must be a positive integer');
  return value;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// Installs the browser build that matches the Playwright bundled with jevcumber; a stray
// `npx playwright install` can fetch a different Playwright and with it the wrong build.
function installBrowser(extraArgs: string[]): number {
  const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium', ...extraArgs], { stdio: 'inherit' });
  return result.status ?? 1;
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'install-browser') return installBrowser(argv.slice(1));

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
    .option('--report-dir <dir>', 'where screenshots and snapshots of failing steps are written', 'jevcumber-report')
    .option('--no-report', 'do not write failure evidence')
    .option(
      '--trace',
      'record a Playwright trace per scenario; kept under --report-dir for scenarios that did not pass (even with --no-report)',
      false,
    )
    .option('--workers <n>', 'number of scenarios to run concurrently (default: available CPUs, or 1 with --headed)', parseWorkers)
    .option('--config <path>', 'path to a jevcumber.config.js/.mjs (default: the nearest one found walking up from cwd)')
    .option('--reporter <name>', 'reporter to use (console, json, junit); repeatable', collect, [] as string[])
    .option('--output <file>', 'output file for the json/junit reporters (default under --report-dir)')
    .addHelpText('after', '\nFirst time? Run `jevcumber install-browser` to download the Chromium build jevcumber drives.')
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
  const workers = fromCli('workers') ? options.workers : (config.workers ?? availableParallelism());
  const reporterNames: ReporterName[] = (options.reporter.length > 0 ? options.reporter : ['console']) as ReporterName[];

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
    });
    if (results.length === 0) {
      console.error('error: no scenarios found');
      return 1;
    }
    return exitCode(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    if (/Executable doesn't exist|playwright install/i.test(message)) {
      console.error('\nThe browser is not installed yet. Run: jevcumber install-browser');
    }
    return 1;
  }
}

// Run only when invoked as a script (npm's bin shim is a symlink, hence realpath).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
