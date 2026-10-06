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
export interface RoleConfig { model?: string; effort?: string; permissionMode?: string; provider?: Provider }

// Model profiles (profiles.ts): a named set of model/effort per role, chosen at runtime in control.json. "opus" is the
// reserved name of the main mode, each role's own config. permissionMode never comes from a profile: always the role's.
export type ProfileRole = 'builder' | 'resolver' | 'evaluator' | 'observer' | 'curator' | 'planner';
export const PROFILE_ROLES: ProfileRole[] = ['builder', 'resolver', 'evaluator', 'observer', 'curator', 'planner'];
export interface ProfileEntry { model?: string; effort?: string; effortHigh?: string; provider?: Provider } // effortHigh: the builder's effort on a risky feature, the planner's on a sensitive spec or after a failure
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
  evaluatorInlineDiffBytes?: number; // safe integer >= 0 (default 12000): a larger diff is not inlined; the evaluator gets the file list and git diff commands (when it can run git)
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
  diagnoser: RoleConfig | null;       // null = none; set = a read-only run diagnoses a repeated gate failure before one more fix
  codex: { fallback: RoleConfig; cooldownMin: number }; // a Codex run that cannot answer falls back to this Claude role config
  planner: PlannerConfig;              // the read-only planning run before a feature's first build (lib/plan.ts)
  observer?: Partial<Omit<ObserverConfig, 'promptReview'>> & { promptReview?: Partial<PromptReviewConfig> }; // read only by `fact-os observe`
  profiles?: Record<string, Profile>; // added to (or replacing, by name) the built-in profiles; "opus" is reserved
}

// The planner (lib/plan.ts): a read-only run before a feature's first build that checks the spec against the code and writes a
// plan for the builder. Always plan mode (read-only); model/effort here are the opus mode's, a profile's `planner` entry overrides.
export interface PlannerConfig {
  enabled: boolean;                   // default true
  model: string;                      // default opus
  effort: string;                     // default medium
  effortHigh: string;                 // default high: a spec with sensitive words, or a feature that already failed an attempt
  maxPerDay: number;                  // planner runs started in any 24 hours (0 = none); over it, builds go on without a plan
  skipBelow: Tier | null;             // null = plan every feature; a tier: features of a lower tier (TIERS order) skip planning
  splitWords: number;                 // default 750: a FEASIBLE plan over it puts the feature on a needs-split hold (no build)
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
  cause: 'spec-error' | 'prompt-conflict' | 'base-defect' | 'spec-conflict' | 'needs-split'; // spec-conflict: the planner found the spec cannot be met;
  // needs-split: its plan ran over config.planner.splitWords words (both before any build)
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
  envRetryAt?: string;                // ISO: no launch before this time (a delayed retry after an environmental gate failure or an evaluator stop)
  evalFailures?: number;              // evaluations with no valid verdict after their re-runs (uncounted stops); never attempts; cleared by a valid verdict or a retry
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
  specFix?: SpecFixProposal;          // the latest drafted spec fix (lib/specfix.ts)
  specFixes?: SpecFixRecord[];        // spec fixes applied to it, oldest first (undo restores the latest)
  specFixDecisions?: Record<string, string>; // spec inputs → what was decided for them (declined, none, applied): never drafted again
  specCheck?: { inputs: string; ts: string; issues: { note: string; quote: string; why: string }[] }; // the pre-launch check against the spec-writing notes (lib/specnotes.ts)
  plan?: PlanSummary;                 // the planner's latest answer for this spec (the plan text is in runs/<id>/plan.md, never committed)
  tier?: Tier;                        // set at intake; picks role models from the active profile's tiers (absent: the risk heuristic)
  risk?: 'high' | 'normal';           // "high": the builder gets its profile's effortHigh; "normal": never; absent: keyword heuristic
  conflict?: { ours: string; theirs: string; files: string[] }; // a conflicted base refresh whose committed resolution is not checked yet
  pid?: number;                       // current child
  pidStart?: string;                  // /proc/<pid>/stat field 22
  foremanPid?: number;
}

export interface PlanSummary { inputs: string; ts: string; verdict: 'FEASIBLE' | 'INFEASIBLE' | 'none'; effort?: 'medium' | 'high'; split?: string | null; error?: string }

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
// Spec fixes: when a feature failed because its spec was wrong, the observer drafts one replacement (Opus) that Codex verifies.
// manual: a person applies it; auto: applied without asking when every guard passes (protected changes stay manual).
export type SpecFixMode = 'manual' | 'auto';
export interface SpecFixProposal {
  id: string; ts: string; status: 'proposed' | 'applied' | 'declined' | 'none' | 'stale';
  inputs: string;                     // holdInputs when drafted: a proposal applies only to exactly that spec
  review: string; sha: string | null; // the prompt review's key and the feature commit it was drafted from (evidence read at it)
  launch?: string;                    // the failed launch it answers (ts): a newer launch makes it stale
  target?: number | 'description';    // 1-based acceptance index
  old?: string; new?: string; why?: string; evidence?: { quote: string; source: string }[];
  reason?: string;                    // status none: why no correction is supported
  drafter: { model: string | null };
  verifier?: { provider: string; model: string | null; agree: boolean | null; reason: string };
  protectedBy?: string;               // why it can only be applied by a person
  autoBlocked?: string;               // why auto mode left it to a person
  counted?: boolean;                  // a counted, substantive failure preceded it (needed for auto)
}
export interface SpecFixRecord { id: string; ts: string; by: 'person' | 'auto'; target: number | 'description'; old: string; new: string; why: string; undone?: string;
  after?: string;                     // holdInputs right after it was applied: undo only while the whole spec is still that
  drafter?: { model: string | null }; verifier?: SpecFixProposal['verifier']; evidence?: SpecFixProposal['evidence']; review?: string }
export interface Control {
  paused: boolean;                    // true: launch nothing new
  maxParallel: number | null;         // 0..32; null = config.maxParallel
  profile?: string | null;            // model profile for new launches; absent or null = "opus" (each role's own config)
  specFixes?: SpecFixMode;            // how a drafted spec fix is applied (lib/specfix.ts); absent = manual
  updatedAt?: string;                 // ISO
  by?: 'dashboard' | 'cli';
}

// An audit event saved in the same write as the change it records, then appended to the log (idempotently, by id).
export interface PendingAudit { id: string; feature: string; event: string; detail: string; attemptsReset?: boolean }
export interface FeaturesFile { features: Feature[]; pendingAudit?: PendingAudit[] }
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
export type RunPhase = 'plan' | 'build' | 'commit' | 'fix-gate' | 'fix-review' | 'fix-keep' | 'fix-progress' | 'resolve' | 'review' | 'diagnose';
export interface RunRecord { phase: RunPhase; tag: string; role: string; provider: string; model: string | null; effort: string | null; tier: string | null;
  resumed: boolean; fallback?: boolean; promptBytes: number; rule?: string; routedByTier?: boolean; // tier: the feature's tier at launch; routedByTier: a tier entry chose this config
  context?: { map: number; atoms: string[]; deferred: { id: string; why: string }[]; atomBytes: number; recap: boolean; lessons?: { included: number; total: number } } } // first build: what the Map section held

// The builder's own account of a run (FINISH_RULE's optional exit block). Self-reported and attributed: it never decides an
// outcome, places a hold or clears a failure; the foreman stores it beside the declared touches and the actual diff.
export const BLOCK_REASONS = ['missing-info', 'spec-conflict', 'environment', 'tooling'] as const;
export interface BuilderExit { touched: string[]; unsure: string[]; blocked: { reason: typeof BLOCK_REASONS[number]; what: string } | null; responses?: ReviewResponse[] }
// A review fix pass's answer to one numbered reviewer finding (the exit block's `responses`, review fixes only). Self-reported:
// the next evaluator gets it as context to verify, never as proof. `key`/`text`: the finding it answers (reviewItems), added by
// the foreman when it stores the exit record.
export const RESPONSE_STATUSES = ['fixed', 'disputed', 'cannot'] as const;
export interface ReviewResponse { finding: number; status: typeof RESPONSE_STATUSES[number]; how: string; where: string; key?: string; text?: string }

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
  audit?: string;                    // an event published from features.json pendingAudit: its id (published once)
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
