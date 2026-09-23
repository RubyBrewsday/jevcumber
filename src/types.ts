export type Keyword = 'Given' | 'When' | 'Then';

export interface Step {
  keyword: Keyword;
  text: string;
  table?: string[][];
  docString?: string;
}

export interface Scenario {
  uri: string;
  feature: string;
  name: string;
  /** Zero-based index of this scenario among scenarios with the same name in the same feature file
   *  (0 for a uniquely-named scenario). Distinguishes Scenario Outline rows in the lockfile key. */
  occurrence: number;
  tags: string[];
  steps: Step[];
}

export type LocatorSpec =
  | { by: 'testid'; value: string }
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; value: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; value: string };

export interface ElementInfo {
  id: string;
  role: string;
  name: string;
  value?: string;
  locator: LocatorSpec;
}

export interface EvidenceItem {
  text: string;
  kind: 'title' | 'heading' | 'link' | 'button';
}

export interface Snapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  text: string;
  evidence: EvidenceItem[];
}

export type Assertion =
  | { form: 'text_visible' | 'text_not_visible' | 'url_contains' | 'title_contains'; value: string; pinned?: true }
  | { form: 'heading_visible'; value: string; pinned?: true }
  | { form: 'element_visible'; locator: LocatorSpec }
  | { form: 'element_has_value'; locator: LocatorSpec; value: string }
  | { form: 'semantic' };

export type ResolvedStep =
  | { kind: 'navigate'; value: string }
  | { kind: 'click' | 'check' | 'uncheck'; locator: LocatorSpec }
  | { kind: 'fill'; locator: LocatorSpec; value: string; submit?: true }
  | { kind: 'select'; locator: LocatorSpec; value: string }
  | { kind: 'press'; key: string; locator?: LocatorSpec }
  | { kind: 'hover' | 'clear' | 'scroll'; locator: LocatorSpec }
  | { kind: 'upload'; locator: LocatorSpec; value: string }
  | { kind: 'wait'; text?: string; seconds?: number }
  | { kind: 'assert'; assertion: Assertion };

export type ResolveOutcome =
  | { ok: true; resolved: ResolvedStep; confidence: number }
  | { ok: false; reason: 'undefined' | 'ambiguous'; detail: string };

export type StepStatus = 'passed' | 'healed' | 'failed' | 'ambiguous' | 'undefined' | 'skipped';

export interface StepResult {
  step: Step;
  status: StepStatus;
  detail?: string;
  note?: string;
}

export interface ExecuteResult {
  pinned?: Assertion;
  /** How sure Jev was of the pinned evidence; stored in the lockfile alongside it. */
  confidence?: number;
}

export interface ScenarioResult {
  scenario: Scenario;
  steps: StepResult[];
}

export type Mode = 'default' | 'frozen' | 'update';
