// Shapes of state files and events, as specified in SPEC.md. loadConfig validates configuration
// at runtime; feature/human JSON is cast at the state boundary and validated by doctor (cli.ts).

export type Status = 'todo' | 'building' | 'testing' | 'evaluating' | 'ready' | 'merged' | 'stuck' | 'paused';
export const STATUSES: Status[] = ['todo', 'building', 'testing', 'evaluating', 'ready', 'merged', 'stuck', 'paused'];
export const IN_FLIGHT: Status[] = ['building', 'testing', 'evaluating'];
export type Surface = 'web' | 'api' | 'ios' | 'android' | 'desktop' | 'any';
export type MergeMode = 'auto' | 'manual';
export type Role = 'builder' | 'evaluator' | 'resolver';

// provider: 'claude' (default) or 'codex' (`codex exec`; only the evaluator and the diagnoser, which change no code).
export type Provider = 'claude' | 'codex';
// I07 v2 shadow classifier. `timeoutMs` bounds a whole decision (every attempt and backoff); `glossary` and `scorer` are paths
// relative to the project root (a codebase glossary sent as context; a frozen rework scorer for the attention priority).
// `auto`: the running observer classifies every open feature that has no current assessment (new or edited), then escalates its
// unsure answers when escalation is enabled. Shadow only either way.
export interface ClassifierConfig { provider: 'typesafe'; model: string; mode: 'shadow'; timeoutMs: number; maxRetries: number; maxRequestsPerDay: number;
  glossary: string | null; scorer: string | null; escalation: EscalationConfig | null; auto: boolean }
// Unsure assessments go to a reasoning agent that reads the code read-only (Codex; config.codex.fallback when Codex is
// unavailable); shadow only, explicit classify runs only. maxPerRun/maxPerDay count actual agent starts, fallback included.
export interface EscalationConfig { enabled: boolean; model: string; effort: string; maxPerDay: number; maxPerRun: number; timeoutMin: number;
  maxQuestions: number; fallbackMaxBudgetUsd: number; reviewPlanning: boolean }
export interface RoleConfig { model?: string; effort?: string; permissionMode?: string; provider?: Provider }

// Model profiles (profiles.ts): a named set of model/effort per role, chosen at runtime in control.json. "opus" is the
// reserved name of the main mode, each role's own config. permissionMode never comes from a profile: always the role's.
export type ProfileRole = 'builder' | 'resolver' | 'evaluator' | 'observer' | 'curator';
export const PROFILE_ROLES: ProfileRole[] = ['builder', 'resolver', 'evaluator', 'observer', 'curator'];
export interface ProfileEntry { model?: string; effort?: string; effortHigh?: string; provider?: Provider } // effortHigh: the builder's effort on a risky feature
// Feature tiers, set at intake: what a feature needs from its builder and reviewer (see README "Feature tiers").
export type Tier = 'normal' | 'multi' | 'hard' | 'risky' | 'investigate';
export const TIERS: Tier[] = ['normal', 'multi', 'hard', 'risky', 'investigate'];
export const TIER_ROLES = ['builder', 'resolver', 'evaluator'] as const;
export type TierEntry = Pick<ProfileEntry, 'model' | 'effort' | 'provider'>;
// ladder: the builder's approved escalation rungs, weakest first. Each counted implementation or review failure in a cycle moves a
// fresh try one rung up from where the feature's profile and tier put it (never down; off the ladder, nothing changes).
export interface Rung { model: string; effort: string }
export type Profile = Partial<Record<ProfileRole, ProfileEntry>> & { tiers?: Partial<Record<Tier, Partial<Record<typeof TIER_ROLES[number], TierEntry>>>>; ladder?: Rung[] };

export interface Config {
  base: string;
  worktreesDir: string;               // '<repo>' is replaced by the repo's dir name on load
  branchPrefix: string;
  maxParallel: number;               // safe integer >= 0; legacy 0 gives one effective lane
  maxAttempts: number;               // safe integer >= 1
  budgetUsdPerRun: number | null;     // null = no cap; > 0 is passed as --max-budget-usd
  budgetUsdTotal: number | null;      // cost reported during this run; null = unlimited
  timeoutMin: number | null;          // per child; null = none; positive, converted ms <= 2^31-1
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
  evaluatorDiffExclude: string[];     // pathspecs listed by name only in the evaluator's diff (generated files, fixtures)
  claims: Partial<ClaimsConfig> | null; // null = schedule by group only; set = also never run two features that share a hot file
  conflictBrief: boolean;             // a conflicting refresh's feedback carries both sides' context; resolutions get the keep-lines check
  resolver: RoleConfig | null;        // null = the builder resolves on its next build; set = a resolver run resolves at once, same pass
  gateFixes: number;                  // safe integer >= 0: resumed builder fixes after a test-gate failure, per pass (0 = none)
  commitFixes: number;                // safe integer >= 0: resumes per pass to commit work the builder left uncommitted (0 = none)
  keepFixes: number;                  // safe integer >= 0: resumes per pass to restore or declare lines the builder's merge resolution lost (0 = none)
  progressFixes: number;              // safe integer >= 0: resumes per pass when a build left the content the evaluator rejected unchanged, before a counted failure with no gate or evaluation (0 = none)
  reviewFixes: number;                // safe integer >= 0: resumes per pass to fix an actionable evaluator rejection, then a fresh gate and evaluation (0 = none)
  contextMaxBytes: number;            // safe integer >= 0: bytes of verified context atoms a builder prompt may carry (lib/context.ts; 0 = none)
  lessonsMaxBytes: number;            // safe integer >= 0: a lessons file over this reaches a fresh build as its most relevant lessons plus the file (0 = always whole)
  recapMaxBytes: number;              // safe integer >= 0: previous-attempt feedback longer than this reaches a fresh try as a recap plus a file (0 = always whole)
  setupRetryDelaysSec: number[];      // delays before each setup retry; one more failure after the last makes the feature stuck
  classifier: ClassifierConfig | null; // I07: TypeSafe Jev tier/split judgments, shadow mode only (records, never changes a feature)
  diagnoser: RoleConfig | null;       // null = none; set = a read-only run diagnoses a repeated gate failure before one more fix
  codex: { fallback: RoleConfig; cooldownMin: number }; // a Codex run that cannot answer falls back to this Claude role config
  observer?: Partial<Omit<ObserverConfig, 'promptReview'>> & { promptReview?: Partial<PromptReviewConfig> }; // read only by `fact-os observe`
  profiles?: Record<string, Profile>; // added to (or replacing, by name) the built-in profiles; "opus" is reserved
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
  goals: boolean;                     // with an agent: write cached dashboard goals for features that have none (a small model, a few per pass)
  improve: boolean;                   // with an agent: turn observations into improvement features and human tasks
  improveEveryHours: number;
  maxOpenImprovements: number;        // improvement features not merged yet
  lessonsMaxBytes: number;            // the agent curates the lessons section once it grows past this
  curateEveryHours: number;           // at most this often
  promptReview: PromptReviewConfig;   // with an agent: review failed passes and keep per-model prompt notes
}

// Reviews of failed passes (promptreview.ts) and the per-model notes the foreman appends to prompts (notes.ts).
export interface PromptReviewConfig {
  enabled: boolean;                   // default true; only runs when an observer agent is configured
  maxPerPass: number;                 // reviews started in one observer pass
  notesMaxBytes: number;              // size cap of one <model>-<role> notes file
  everyMinutes: number;               // at most one batch of reviews this often
  maxPerDay: number;                  // review runs (successful or not) in any 24 hours
}
export const PROMPT_CAUSES = ['prompt-missing-info', 'prompt-ambiguous', 'prompt-conflict', 'model-limitation', 'environment', 'spec-error'] as const;
export type PromptCause = typeof PROMPT_CAUSES[number];

// What the observer decided about one stuck feature.
export type Cause = 'untouched' | 'infra' | 'own' | 'conflict-loop' | 'setup' | 'builder' | 'environment' | 'base-defect' | 'unknown';
export interface Diagnosis { ts: string; feature: string; cause: Cause; tests: string[]; evidence: string; action: string }

export interface AttemptStop { attempt: number; counted: boolean }

// A launch hold the observer places when a review of the feature's latest failed pass shows, with evidence checked against the
// saved prompt and outcome, that the spec or the prompt cannot be met as written. Not a person's pause: no attempt is spent, and
// it is released by an edit of the feature's inputs (its fingerprint changes) or by a person (`release`), never by time.
export interface PlanningHold {
  cause: 'spec-error' | 'prompt-conflict' | 'base-defect';
  confidence: 'medium' | 'high';
  base?: string;                      // base-defect: the base commit at the hold; a later base that changes `paths` rechecks it (at most twice per signature)
  paths?: string[];                   // base-defect: the paths implicated in the defects
  signatures?: string[];              // base-defect: the defects' failure signatures
  evidence: string[];                 // the reviewer's quotes, each found in the saved prompt or the outcome
  review: string;                     // the review key (<feature>/<tag>) of the failed pass
  passEnd: string;                    // ISO end of that pass
  inputs: string;                     // holdInputs fingerprint when placed: description, acceptance, deps and briefs
  ts: string;
}

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
  stop?: AttemptStop;                 // latest counted failure or uncounted stop; cleared when work resumes
  setupFailures?: number;             // consecutive failed setups (prepare) of this feature; never attempts; cleared by a good setup or retry
  setupRetryAt?: string;              // ISO: no launch before this time (a delayed setup retry)
  envFailures?: number;               // gate failures diagnosed as environmental, after a same-build rerun; never attempts; cleared by a passing gate or a retry
  envRetryAt?: string;                // ISO: no launch before this time (a delayed retry after an environmental gate failure)
  goal?: string;                      // one plain sentence: what this feature is for (written with the feature; shown first on the dashboard)
  shortTitle?: string;                // a short display title (the title stays the record)
  planningHold?: PlanningHold;
  baseRechecks?: Record<string, number>; // automatic base-defect rechecks spent, per failure signature (at most 2 each)
  baseRecheck?: boolean;              // released for a base-defect recheck: the next pass merges current base before validating
  rejected?: { sha: string; tree: string; inputs: string }; // the content an evaluator last rejected, and what it was validated against (validationInputs)
  envBuild?: string;
  envBuildInputs?: string;            // what envBuild was built for (spec, briefs, role instructions, mocks): reused only while equal                  // the commit held after an environmental gate failure: the next pass revalidates it instead of rebuilding
  refreshes?: number;
  lastFeedback?: string;
  costUsd?: number;
  updatedAt: string;                  // ISO
  sha?: string;                       // evaluated commit; auto persists before merge, may survive parking/interruption
  pendingLesson?: { sha: string; text: string }; // foreman-owned passing auto lesson, delivered after this commit merges
  parked?: boolean;
  pausedAt?: string;                  // ISO, while paused
  issue?: number;                     // GitHub issue number
  touches?: string[];                 // files (or dir prefixes ending in "/") it is expected to change: claimed while it runs
  tier?: Tier;                        // set at intake; picks role models from the active profile's tiers (absent: the risk heuristic)
  risk?: 'high' | 'normal';           // "high": the builder gets its profile's effortHigh; "normal": never; absent: keyword heuristic
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

// <state dir>/control.json: a person's runtime limits on new launches (CLI or dashboard). Not config.json, so changing it
// never trips the foreman's tamper halt. Nothing in flight is ever interrupted by it.
export interface Control {
  paused: boolean;                    // true: launch nothing new
  maxParallel: number | null;         // 0..32; null = config.maxParallel
  profile?: string | null;            // model profile for new launches; absent or null = "opus" (each role's own config)
  updatedAt?: string;                 // ISO
  by?: 'dashboard' | 'cli';
}

export interface FeaturesFile { features: Feature[] }
export interface HumanFile { tasks: HumanTask[] }
export interface StateFiles { features: FeaturesFile; human: HumanFile }
export type StateName = keyof StateFiles;

// Issue kinds a reviewer may tag (what is wrong, not why it happened: causes are the observer's hypotheses).
export const ISSUE_KINDS = ['duplicated-helper', 'missing-wiring', 'evidence-missing', 'contract-mismatch', 'weak-test', 'defect-money-auth-tenant', 'defect-state-concurrency', 'scope', 'other'] as const;
export type IssueKind = typeof ISSUE_KINDS[number];
// `criterion`: the 1-based index of the acceptance item it judges (as listed in the reviewed spec) or `extra:<name>`; `kind` on a failed finding.
export interface Finding { check: string; ok: boolean; evidence: string; criterion?: number | string; kind?: IssueKind }
// A failure the evaluator reproduced on the base commit as well, with the same signature: not this feature's to fix.
export interface BaseDefect { check: string; command: string; signature: string; baseSha: string; featureSha: string; evidence: string; paths?: string[];
  setup?: string; baseOutput?: string; featureOutput?: string } // the reproduction: equivalent setup, and each run's failing output
export interface Verdict {
  pass: boolean; findings: Finding[]; cheating: string[]; blocking: string[]; notes: string[]; lesson: string | null; error?: string;
  baseDefects?: BaseDefect[]; // failures reproduced on base too; each names the failed finding (check) it explains
  summary?: string;           // optional: one plain sentence on the decisive outcome (display only; never decides pass or fail)
  blockingKinds?: (IssueKind | null)[]; // optional, aligned with `blocking`: each entry's issue kind (a bad value is dropped, never the blocker)
  diagnostic?: string; // bounded unvalidated original output, only on JSON/root/schema rejection
}

// One agent invocation, as the foreman launched it (the run ledger). `model`/`effort` are what was requested; the run artifact
// holds what the provider reports. `phase` tells a first build from each kind of repair, a review and a diagnosis.
// A counted failure's provenance. Only 'review' (a valid rejection, or a rebuild that left rejected content unchanged) and
// 'gate-own' (a gate failure a diagnosis attributed to the feature's code or tests) are the builder's implementation failing.
export type FailureKind = 'review' | 'gate-own' | 'gate' | 'evaluator' | 'builder' | 'commit' | 'keep' | 'merge' | 'setup' | 'other';
export type RunPhase = 'build' | 'commit' | 'fix-gate' | 'fix-review' | 'fix-keep' | 'fix-progress' | 'resolve' | 'review' | 'diagnose';
export interface RunRecord { phase: RunPhase; tag: string; role: string; provider: string; model: string | null; effort: string | null; tier: string | null;
  resumed: boolean; fallback?: boolean; promptBytes: number; rule?: string; routedByTier?: boolean; // tier: the feature's tier at launch; routedByTier: a tier entry chose this config
  context?: { map: number; atoms: string[]; deferred: { id: string; why: string }[]; atomBytes: number; recap: boolean; lessons?: { included: number; total: number } } } // first build: what the Map section held

// The builder's own account of a run (FINISH_RULE's optional exit block). Self-reported and attributed: it never decides an
// outcome, places a hold or clears a failure; the foreman stores it beside the declared touches and the actual diff.
export const BLOCK_REASONS = ['missing-info', 'spec-conflict', 'environment', 'tooling'] as const;
export interface BuilderExit { touched: string[]; unsure: string[]; blocked: { reason: typeof BLOCK_REASONS[number]; what: string } | null }

// log.jsonl
export interface LogEvent {
  ts: string; feature: string | null; event: string; detail: string;
  stop?: AttemptStop;                 // failed/stuck event's try and whether it consumed a failed attempt
  attemptsReset?: boolean;           // resume/retry event: whether failed-attempt numbering restarted
  cause?: 'environment' | 'base-defect'; // failed/stuck event: a typed cause (a diagnosed environmental gate failure, or a rejection only for defects on base)
  sha?: string;                      // the commit that cause was diagnosed on
  inputs?: string;                   // launch event: holdInputs of the launched spec (a planning hold must match it)
  test?: { code: number | null; file: string | null; error: string | null }; // gate-fix / env-rerun / failed: the failed gate's outcome
  run?: RunRecord;                   // prompt event: who ran this invocation, in which phase, with what (the run ledger)
  failure?: FailureKind;             // failed/stuck event: where the failure came from, set where it happened (the retry ladder reads it)
  // Foreman-generated whole-file SHA-256 chain, published under the checkout lock.
  lessonAppend?: { file: string; before: string; after: string };
}
// activity.jsonl
export interface ActivityEvent { ts: string; session: string | null; feature: string | null; tool: string; summary: string }

// What the foreman takes from `claude -p --output-format json`.
export interface ClaudeResult { ok: boolean; text: string; cost: number; error?: string; sessionId?: string }

export interface Paths {
  name: string; dir: string; config: string; features: string; human: string;
  log: string; activity: string; lock: string; foreman: string; runs: string; control: string;
}
