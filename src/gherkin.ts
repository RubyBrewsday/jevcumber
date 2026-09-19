import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';
import parseTagExpression from '@cucumber/tag-expressions';
import type { Keyword, Scenario, Step } from './types.js';

// Pickle step types already fold And/But into the preceding primary keyword.
const KEYWORDS: Record<string, Keyword> = { Context: 'Given', Action: 'When', Outcome: 'Then' };

export function parseFeature(source: string, uri: string): Scenario[] {
  const envelopes = generateMessages(source, uri, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeSource: false,
    includeGherkinDocument: true,
    includePickles: true,
    newId: IdGenerator.uuid(),
  });

  let feature = '';
  const scenarios: Scenario[] = [];
  const occurrences = new Map<string, number>(); // per-file count of scenarios seen with each name so far
  for (const envelope of envelopes) {
    if (envelope.parseError) {
      throw new Error(`${uri}: ${envelope.parseError.message}`);
    }
    if (envelope.gherkinDocument) {
      feature = envelope.gherkinDocument.feature?.name ?? '';
    }
    if (envelope.pickle) {
      const pickle = envelope.pickle;
      const occurrence = occurrences.get(pickle.name) ?? 0;
      occurrences.set(pickle.name, occurrence + 1);
      scenarios.push({
        uri,
        feature,
        name: pickle.name,
        occurrence,
        tags: pickle.tags.map((tag) => tag.name),
        steps: pickle.steps.map((pickleStep): Step => {
          const step: Step = { keyword: KEYWORDS[pickleStep.type ?? ''] ?? 'When', text: pickleStep.text };
          const table = pickleStep.argument?.dataTable;
          if (table) step.table = table.rows.map((row) => row.cells.map((cell) => cell.value));
          const docString = pickleStep.argument?.docString;
          if (docString) step.docString = docString.content;
          return step;
        }),
      });
    }
  }
  return scenarios;
}

export function findFeatureFiles(paths: string[]): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (entry !== 'node_modules') visit(join(path, entry));
      }
    } else if (path.endsWith('.feature')) {
      files.push(path);
    }
  };
  paths.forEach(visit);
  return files;
}

export function loadFeatures(paths: string[], tagExpr?: string): Scenario[] {
  const scenarios = findFeatureFiles(paths).flatMap((file) => parseFeature(readFileSync(file, 'utf8'), file));
  if (!tagExpr) return scenarios;
  const expression = parseTagExpression(tagExpr);
  return scenarios.filter((scenario) => expression.evaluate(scenario.tags));
}
