// Shapes of the state files and events, as specified in SPEC.md. JSON read from disk is only trusted
// after readJson (state.ts) casts it; doctor (cli.ts) is what validates it.

export type Status = 'todo' | 'building' | 'testing' | 'evaluating' | 'ready' | 'merged' | 'stuck' | 'paused';
export const STATUSES: Status[] = ['todo', 'building', 'testing', 'evaluating', 'ready', 'merged', 'stuck', 'paused'];
export type Surface = 'web' | 'api' | 'ios' | 'android' | 'desktop' | 'any';
export type MergeMode = 'auto' | 'manual';
export type Role = 'builder' | 'evaluator' | 'resolver';

export interface RoleConfig { model?: string; effort?: string; permissionMode?: string }

export interface Config {
  base: string;
  worktreesDir: string;               // '<repo>' is replaced by the repo's dir name on load
  branchPrefix: string;
  maxParallel: number;
  maxAttempts: number;
  budgetUsdPerRun: number | null;     // null = no cap; > 0 is passed as --max-budget-usd
  budgetUsdTotal: number | null;      // cost reported during this run; null = unlimited
  timeoutMin: number | null;          // per child; null = no timeout
  builder: RoleConfig;
  evaluator: RoleConfig;
  test: string;
  merge: MergeMode;
  briefFiles: string[];
  lessonsFile: string;
  postMerge: string | null;
  prepare: string | null;             // run in the feature worktree before every build
  refreshBeforeTest: boolean;
  maxRefreshes: number;
  mergeHook: string | null;
  groupBy: string | null;             // null or "idPrefix:<n>"
  restoreFrom: string | null;         // null or a ref with "{id}", e.g. "archive/task/{id}": earlier work for a branch with none
  claims: Partial<ClaimsConfig> | null; // null = schedule by group only; set = also never run two features that share a hot file
  conflictBrief: boolean;             // a conflicting refresh's feedback carries both sides' context; resolutions get the keep-lines check
  resolver: RoleConfig | null;        // null = the builder resolves on its next build; set = a resolver run resolves at once, same pass
  observer?: Partial<ObserverConfig>; // read only by `fact-os observe`
}

// File claims (docs/merge-process.md): a file is hot when listed in `hot` (a path, or a dir prefix ending in "/") or
// when its conflicting refreshes in the last `days` days score at least `minScore` (1 each, 2 for a bounce).
export interface ClaimsConfig { hot: string[]; minScore: number; days: number }

export interface ObserverConfig {
  pollSec: number;                    // how often the log is read
  retry: boolean;                     // send back features stuck for a cause outside them
  maxRetries: number;                 // per feature and failure signature
  infraPatterns: string[];            // extra substrings (case-insensitive) that mark an infrastructure failure
  recurring: number;                  // a test failing in this many features (24h) is recurring
  agent: RoleConfig | null;           // null = observe and send back only; set = also curate lessons and improve
  improve: boolean;                   // with an agent: turn observations into improvement features and human tasks
  improveEveryHours: number;
  maxOpenImprovements: number;        // improvement features not merged yet
  lessonsMaxBytes: number;            // the agent curates the lessons section once it grows past this
  curateEveryHours: number;           // at most this often
}

// What the observer decided about one stuck feature.
export type Cause = 'untouched' | 'infra' | 'own' | 'conflict-loop' | 'setup' | 'builder' | 'unknown';
export interface Diagnosis { ts: string; feature: string; cause: Cause; tests: string[]; evidence: string; action: string }

export interface Feature {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  surface: Surface;
  deps: string[];
  priority: number;                   // lower = sooner
  branch?: string;
  group?: string;
  status: Status;
  onMock?: boolean;
  attempts: number;
  refreshes?: number;
  lastFeedback?: string;
  costUsd?: number;
  updatedAt: string;                  // ISO
  sha?: string;                       // evaluated commit (ready/merged)
  parked?: boolean;
  pausedAt?: string;                  // ISO, while paused
  issue?: number;                     // GitHub issue number
  touches?: string[];                 // files (or dir prefixes ending in "/") it is expected to change: claimed while it runs
  conflict?: { ours: string; theirs: string; files: string[] }; // a conflicted base refresh whose committed resolution is not checked yet
  pid?: number;                       // current child
  pidStart?: string;                  // /proc/<pid>/stat field 22
  foremanPid?: number;
}

export interface HumanTask {
  id: string;
  title: string;
  steps: string[];
  unblocks: string[];                 // feature ids
  mockable: boolean;
  status: 'open' | 'done';
  doneAt?: string;
  startedAt?: string;                 // set once the person begins; makes it "doing"
  checked?: number[];                 // indexes of steps already done
  waitingOn?: string;                 // who the person is waiting on (vendor etc.); status stays open
  waitingSince?: string;              // ISO
}

export interface FeaturesFile { features: Feature[] }
export interface HumanFile { tasks: HumanTask[] }
export interface StateFiles { features: FeaturesFile; human: HumanFile }
export type StateName = keyof StateFiles;

export interface Finding { check: string; ok: boolean; evidence: string }
export interface Verdict { pass: boolean; findings: Finding[]; cheating: string[]; lesson: string | null; error?: string }

// log.jsonl
export interface LogEvent { ts: string; feature: string | null; event: string; detail: string }
// activity.jsonl
export interface ActivityEvent { ts: string; session: string | null; feature: string | null; tool: string; summary: string }

// What the foreman takes from `claude -p --output-format json`.
export interface ClaudeResult { ok: boolean; text: string; cost: number; error?: string }

export interface Paths {
  name: string; dir: string; config: string; features: string; human: string;
  log: string; activity: string; lock: string; foreman: string; runs: string;
}
