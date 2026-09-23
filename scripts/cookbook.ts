import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeResolved } from '../src/explain.js';
import { findFeatureFiles, parseFeature } from '../src/gherkin.js';
import type { ResolvedStep } from '../src/types.js';
import { RESOLVED } from '../fixtures/expected.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

interface Row {
  text: string;
  resolved: ResolvedStep;
}

// Section order for resolved.kind, matching the order steps tend to appear in a scenario;
// asserts come last, one section per assertion form.
const KIND_ORDER: ResolvedStep['kind'][] = [
  'navigate',
  'fill',
  'click',
  'select',
  'check',
  'uncheck',
  'press',
  'hover',
  'clear',
  'scroll',
  'upload',
  'wait',
];

const KIND_TITLES: Record<Exclude<ResolvedStep['kind'], 'assert'>, string> = {
  navigate: 'Navigate',
  fill: 'Fill',
  click: 'Click',
  select: 'Select',
  check: 'Check',
  uncheck: 'Uncheck',
  press: 'Press a key',
  hover: 'Hover',
  clear: 'Clear',
  scroll: 'Scroll',
  upload: 'Upload',
  wait: 'Wait',
};

const ASSERTION_FORM_ORDER = [
  'text_visible',
  'text_not_visible',
  'url_contains',
  'title_contains',
  'heading_visible',
  'element_visible',
  'element_has_value',
  'semantic',
] as const;

const ASSERTION_FORM_TITLES: Record<(typeof ASSERTION_FORM_ORDER)[number], string> = {
  text_visible: 'Assert: text visible',
  text_not_visible: 'Assert: text not visible',
  url_contains: 'Assert: URL contains',
  title_contains: 'Assert: title contains',
  heading_visible: 'Assert: heading visible',
  element_visible: 'Assert: element visible',
  element_has_value: 'Assert: element has value',
  semantic: 'Assert: judged live by Jev',
};

function collectRowsFromFeatures(): Row[] {
  const paths = [join(ROOT, 'fixtures/features'), join(ROOT, 'fixtures/eval'), join(ROOT, 'examples')];
  const rows: Row[] = [];
  for (const file of findFeatureFiles(paths)) {
    const scenarios = parseFeature(readFileSync(file, 'utf8'), file);
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        const resolved = RESOLVED[step.text];
        if (resolved) rows.push({ text: step.text, resolved });
      }
    }
  }
  return rows;
}

function collectRowsFromLockfiles(): Row[] {
  const examplesDir = join(ROOT, 'examples');
  const rows: Row[] = [];
  for (const entry of readdirSync(examplesDir).sort()) {
    if (!entry.endsWith('.lock.json')) continue;
    const lock = JSON.parse(readFileSync(join(examplesDir, entry), 'utf8')) as {
      steps: Record<string, { text: string; resolved: ResolvedStep }>;
    };
    for (const value of Object.values(lock.steps)) {
      rows.push({ text: value.text, resolved: value.resolved });
    }
  }
  return rows;
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Map<string, Row>();
  for (const row of rows) if (!seen.has(row.text)) seen.set(row.text, row);
  return [...seen.values()];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function groupKey(resolved: ResolvedStep): string {
  return resolved.kind === 'assert' ? `assert:${resolved.assertion.form}` : resolved.kind;
}

function sectionTitle(key: string): string {
  if (key.startsWith('assert:')) {
    const form = key.slice('assert:'.length) as (typeof ASSERTION_FORM_ORDER)[number];
    return ASSERTION_FORM_TITLES[form];
  }
  return KIND_TITLES[key as Exclude<ResolvedStep['kind'], 'assert'>];
}

function orderedSectionKeys(rows: Row[]): string[] {
  const present = new Set(rows.map((row) => groupKey(row.resolved)));
  const ordered: string[] = [];
  for (const kind of KIND_ORDER) if (present.has(kind)) ordered.push(kind);
  for (const form of ASSERTION_FORM_ORDER) {
    const key = `assert:${form}`;
    if (present.has(key)) ordered.push(key);
  }
  return ordered;
}

function renderSection(title: string, rows: Row[]): string {
  const body = rows
    .map(
      (row) =>
        `        <tr><td><code>${escapeHtml(row.text)}</code></td><td>${escapeHtml(describeResolved(row.resolved))}</td></tr>`,
    )
    .join('\n');
  return `      <section class="card">
        <h2>${escapeHtml(title)}</h2>
        <table>
          <thead><tr><th>Step</th><th>What jevcumber does</th></tr></thead>
          <tbody>
${body}
          </tbody>
        </table>
      </section>`;
}

export function buildCookbook(): string {
  const rows = dedupe([...collectRowsFromFeatures(), ...collectRowsFromLockfiles()]);
  const byGroup = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupKey(row.resolved);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(row);
  }

  const sections = orderedSectionKeys(rows)
    .map((key) => renderSection(sectionTitle(key), byGroup.get(key)!))
    .join('\n\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jevcumber cookbook — step phrasings Jev resolves</title>
<meta name="description" content="Every step phrasing verified against Jev in jevcumber's own test suite, grouped by what it does.">
<link rel="canonical" href="https://jevcumber.dev/cookbook">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&family=Hanken+Grotesk:ital,wght@0,400;0,500;0,700;1,400&family=Martian+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root {
  --paper: #f3edd7;
  --paper-deep: #e9e0c2;
  --card: #fbf8ec;
  --ink: #17301b;
  --ink-soft: #46604a;
  --pickle: #2f5d34;
  --pickle-bright: #4f8a3c;
  --brine: #c9d66b;
  --mustard: #e2b13c;
  --tomato: #c4462d;
  --rule: #17301b26;
  --display: "Bagel Fat One", "Cooper Black", serif;
  --body: "Hanken Grotesk", system-ui, sans-serif;
  --mono: "Martian Mono", ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--paper);
  color: var(--ink);
  font: 400 18px/1.6 var(--body);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap { width: min(1180px, 100% - 40px); margin-inline: auto; }
code, pre, .mono { font-family: var(--mono); }
code { font-size: .82em; background: var(--paper-deep); padding: .12em .4em; border-radius: 4px; }

nav { display: flex; align-items: center; justify-content: space-between; padding: 22px 0; }
.mark { font: 400 28px/1 var(--display); color: var(--pickle); text-decoration: none; letter-spacing: .01em; }
.mark span { display: inline-block; transform: rotate(-18deg) translateY(2px); margin-right: 4px; }
nav ul { display: flex; gap: 26px; list-style: none; padding: 0; font-size: 15px; font-weight: 500; }
nav ul a { text-decoration: none; border-bottom: 2px solid transparent; padding-bottom: 2px; transition: border-color .2s; }
nav ul a:hover { border-color: var(--mustard); }

.eyebrow { font: 600 11.5px/1.5 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--ink-soft); display: flex; gap: 14px; align-items: center; margin-top: 30px; }
.eyebrow::before { content: ""; width: 34px; height: 2px; background: var(--mustard); }
h1 { font: 400 clamp(38px, 5.4vw, 60px)/1.02 var(--display); color: var(--pickle); margin: 18px 0 20px; }
.lede { font-size: 19px; max-width: 46em; color: var(--ink-soft); margin-bottom: 20px; }
.lede strong { color: var(--ink); font-weight: 700; }

.card { background: var(--card); border: 2px solid var(--ink); border-radius: 10px; box-shadow: 8px 8px 0 var(--ink); padding: 28px 30px 32px; margin-top: 48px; }
h2 { font: 400 clamp(26px, 3.2vw, 38px)/1 var(--display); color: var(--pickle); margin: 0 0 18px; }

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead th { text-align: left; font: 600 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); border-bottom: 2px solid var(--ink); padding: 0 12px 10px 0; }
tbody td { padding: 12px 12px 12px 0; border-bottom: 1px solid var(--rule); vertical-align: top; font-size: 15.5px; }
tbody tr:last-child td { border-bottom: 0; }
td, code { overflow-wrap: anywhere; word-break: break-word; }
thead th:first-child, tbody td:first-child { width: 45%; }
thead th:last-child, tbody td:last-child { width: 55%; }

.fine { margin: 56px 0 80px; font-size: 15px; color: var(--ink-soft); max-width: 46em; }
.fine + .fine { margin-top: -40px; }

footer { margin-top: 60px; border-top: 2px solid var(--ink); padding: 30px 0 50px; display: flex; flex-wrap: wrap; gap: 14px 30px; justify-content: space-between; font-size: 14.5px; color: var(--ink-soft); }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="mark" href="/"><span>🥒</span>jevcumber</a>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="https://github.com/RubyBrewsday/jevcumber">GitHub ↗</a></li>
    </ul>
  </nav>

  <p class="eyebrow">The cookbook</p>
  <h1>Step phrasings Jev resolves.</h1>
  <p class="lede">Every row here is a step phrasing pulled straight from jevcumber's own test suite — the fixtures and examples it is evaluated against — and the resolution Jev is verified to produce for it. <strong>These aren't hypothetical.</strong> Use them as a starting point for your own <code>.feature</code> files.</p>

${sections}

  <p class="fine">Quoted data matters: Jev selects the values in your step, it never invents them, so <code>"alice@example.com"</code> resolves and an unquoted description of an email does not. Page-like control names matter too — "the Log in button" or a quoted <code>"Log in"</code> match what's really on the page; a vague description gives Jev nothing to select from. See the <a href="https://github.com/RubyBrewsday/jevcumber#writing-steps-jev-can-resolve">README</a> for the full house rules.</p>

  <footer>
    <span><a class="mark" style="font-size:20px" href="/"><span>🥒</span>jevcumber</a></span>
    <span><a href="https://github.com/RubyBrewsday/jevcumber">GitHub</a> · <a href="https://github.com/RubyBrewsday/jevcumber/blob/main/LICENSE">MIT License</a> · <a href="https://docs.typesafe.ai">Jev docs</a></span>
  </footer>
</div>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(ROOT, 'site/cookbook.html'), buildCookbook());
  console.log('Wrote site/cookbook.html');
}
