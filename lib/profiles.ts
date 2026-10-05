// Model profiles: which model and effort each role runs with, switched at runtime in control.json (`profile`). "opus", the
// main mode, is each role's own config; any other profile overrides model/effort for the roles it names (permissionMode
// always stays the role's). Pure: no I/O, so the foreman, the observer, the CLI and the dashboard resolve roles alike.
import { PROFILE_ROLES, TIERS, TIER_ROLES, type Config, type FailureKind, type Feature, type LogEvent, type Profile, type ProfileEntry, type ProfileRole, type RoleConfig, type Rung, type Tier, type TierEntry } from './types.ts';

export const OPUS = 'opus';
// Fable thinks (evaluation, the observer's improver, lessons curation); Sonnet writes the code (builder, merge resolver).
export const DEFAULT_PROFILES: Record<string, Profile> = {
  'fable-sonnet': {
    builder: { model: 'sonnet', effort: 'medium', effortHigh: 'high' },
    resolver: { model: 'sonnet', effort: 'high' },
    evaluator: { model: 'fable', effort: 'high' },
    observer: { model: 'fable', effort: 'high' },
    curator: { model: 'fable', effort: 'medium' },
  },
};
const LABELS: Record<string, string> = { [OPUS]: 'Opus', 'fable-sonnet': 'Fable + Sonnet' };
export const profileLabel = (name: string | null): string => LABELS[name ?? OPUS] ?? name!;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

// Built-ins overlaid by config.profiles (same name = replaced). The reserved names ("opus", and "default", which selects it)
// and non-object entries are skipped here; doctor flags them.
const RESERVED = [OPUS, 'default'];
export function profiles(config: Pick<Config, 'profiles'>): Record<string, Profile> {
  const own = Object.entries(isObj(config.profiles) ? config.profiles : {}).filter(([k, v]) => !RESERVED.includes(k) && isObj(v));
  return { ...DEFAULT_PROFILES, ...Object.fromEntries(own) };
}
export const profileNames = (config: Pick<Config, 'profiles'>): string[] => [OPUS, ...Object.keys(profiles(config))];
// null (= opus) or a known name.
export const validProfile = (config: Pick<Config, 'profiles'>, x: unknown): x is string | null =>
  x === null || (typeof x === 'string' && profileNames(config).includes(x));
// What control.json stores: "opus" and "default" are the main mode, written as null.
export const normalizeProfile = (x: string | null): string | null => (x === null || x === OPUS || x === 'default' ? null : x);

// ---- risk: the builder's effortHigh ----

// Keyword families, each a case-insensitive whole-word pattern over a feature's title or description. "auth" never matches
// "author"; "token" only in its auth senses (an access/refresh/API/session token, a JWT, an API key), never "design tokens";
// "lock" never "block"/"clock", a lock file ("bun.lock", "pnpm-lock.yaml", "lockfile", "lock file") or "-lock"; "race"
// never "trace"/"brace".
export const RISK_KEYWORDS: Record<string, string> = {
  money: 'money',
  payment: 'payments?',
  refund: 'refund(s|ed|ing|able)?',
  price: 'prices?|priced|pricing',
  invoice: 'invoic(e|es|ed|ing)',
  tax: 'tax(es|ed|ing)?',
  permission: 'permissions?',
  auth: 'o?auth[nz]?\\d*|(un|re)?authenticat(e|es|ed|ing|ion|ions)|(un)?authori[sz](e|es|ed|ing|ation|ations)',
  token: 'jwts?|api[ -]keys?|(access|refresh|auth|bearer|api|session|csrf|id)[ -]tokens?',
  tenant: 'tenants?|tenancy|multi-tenant',
  rls: 'rls',
  migration: 'migrations?|migrat(e|es|ed|ing)',
  concurrency: 'concurren(cy|t|tly)',
  lock: '(?<![-.])(dead)?lock(s|ed|ing)?(?![ -]?files?\\b)',
  race: 'races?|race[ -]conditions?',
  'state machine': 'state[ -]machines?',
};
const FAMILIES = Object.entries(RISK_KEYWORDS).map(([name, re]) => [name, new RegExp(`\\b(${re})\\b`, 'i')] as const);
// The keyword families a text mentions.
export const riskFamilies = (text: string): string[] => FAMILIES.filter(([, re]) => re.test(text)).map(([name]) => name);

// An explicit tag wins ("high" = risky, any other value = not). Untagged: a keyword in the title, or at least two distinct
// keyword families in the description (long descriptions mention a migration or a payment in passing; one is not enough).
export function isRisky(f: Pick<Feature, 'title' | 'description'> & { risk?: unknown }): boolean {
  if (f.risk !== undefined) return f.risk === 'high';
  return riskFamilies(f.title || '').length > 0 || riskFamilies(f.description || '').length >= 2;
}

// Not-merged features the builder would escalate for (under a profile with effortHigh), for `fact-os profile` and doctor.
export const riskyOpen = (features: (Parameters<typeof isRisky>[0] & Pick<Feature, 'status'>)[]): { risky: number; open: number } => {
  const open = features.filter((f) => f.status !== 'merged');
  return { risky: open.filter(isRisky).length, open: open.length };
};

// ---- resolution ----

const baseOf = (config: Config, role: ProfileRole, agent?: RoleConfig | null): RoleConfig =>
  (role === 'observer' || role === 'curator' ? agent : role === 'resolver' ? config.resolver ?? config.builder
    : role === 'planner' ? { model: config.planner?.model, effort: config.planner?.effort } : config[role]) || {};
const entryOf = (config: Config, profile: string | null, role: ProfileRole): ProfileEntry | undefined =>
  profile == null || profile === OPUS ? undefined : profiles(config)[profile]?.[role];

// A feature as role resolution sees it: the risk heuristic's fields and the tier set at intake.
type Tiered = Parameters<typeof isRisky>[0] & { tier?: Tier };
// The tier entry a launch uses for `role`: only under a profile (opus is each role's own config), only for a tiered feature.
const tierEntryOf = (config: Config, profile: string | null, role: ProfileRole, feature?: Tiered): TierEntry | undefined =>
  profile == null || profile === OPUS || !feature?.tier || !(TIER_ROLES as readonly string[]).includes(role) ? undefined
    : profiles(config)[profile]?.tiers?.[feature.tier]?.[role as typeof TIER_ROLES[number]];
// The tier that changed `role` for this feature (for its prompt fingerprint), or null.
export const tierApplies = (config: Config, profile: string | null, role: ProfileRole, feature?: Tiered): Tier | null =>
  tierEntryOf(config, profile, role, feature) ? feature!.tier! : null;

// The builder escalates to its profile's effortHigh on a risky feature that has no tier; opus never escalates (its effort is
// the config's). A tier set at intake replaces the heuristic.
export const escalates = (config: Config, profile: string | null, feature?: Tiered): boolean =>
  !!feature && !feature.tier && !!entryOf(config, profile, 'builder')?.effortHigh && isRisky(feature);

// The RoleConfig a launch actually uses. Base: the role's config (resolver falls back to builder, like claudeArgs always did;
// observer/curator take the observer's agent config, passed in by the caller). A profile naming the role overrides model and
// effort where its entry has them; permissionMode stays the base's. An unknown profile resolves like opus (callers validate).
// Then the feature's tier entry in that profile overrides model, effort and provider for the roles it names.
export function resolveRole(config: Config, profile: string | null, role: ProfileRole, { feature, agent }: { feature?: Tiered; agent?: RoleConfig | null } = {}): RoleConfig {
  const base = baseOf(config, role, agent), e = entryOf(config, profile, role), t = tierEntryOf(config, profile, role, feature);
  if (!e && !t) return { ...base };
  const effort = role === 'builder' && e?.effortHigh && feature && !feature.tier && isRisky(feature) ? e.effortHigh : e?.effort ?? base.effort;
  const r: RoleConfig = { ...base, ...(e?.model ? { model: e.model } : {}), ...(effort ? { effort } : {}), ...(e?.provider ? { provider: e.provider } : {}) };
  return { ...r, ...(t?.model ? { model: t.model } : {}), ...(t?.effort ? { effort: t.effort } : {}), ...(t?.provider ? { provider: t.provider } : {}) };
}

// ---- planner ----

// A spec the planner reads at its high effort: one that says what must not change or must hold everywhere, or touches money,
// permissions, tokens or tenants (the RISK_KEYWORDS families of those). Whole words, case-insensitive.
const PLAN_HIGH = /\b(must not change|all paths|every)\b/i;
const PLAN_FAMILIES = ['money', 'payment', 'refund', 'price', 'invoice', 'tax', 'permission', 'auth', 'token', 'tenant', 'rls'];
export const sensitiveSpec = (f: Pick<Feature, 'title' | 'description'> & { acceptance?: string[] }): boolean => {
  const text = [f.title, f.description, ...(f.acceptance ?? [])].join('\n');
  return PLAN_HIGH.test(text) || riskFamilies(text).some((x) => PLAN_FAMILIES.includes(x));
};
// The planner's RoleConfig: the profile's `planner` entry over config.planner; its effortHigh on a sensitive spec or once the feature
// has failed an attempt. Always plan mode (read-only) and Claude: it never takes the profile's or a role's permissionMode.
export function plannerRole(config: Config, profile: string | null, f: Pick<Feature, 'title' | 'description' | 'attempts'> & { acceptance?: string[] }): RoleConfig & { high: boolean } {
  const e = entryOf(config, profile, 'planner'), high = (f.attempts || 0) > 0 || sensitiveSpec(f);
  const effort = high ? e?.effortHigh ?? config.planner?.effortHigh ?? e?.effort ?? config.planner?.effort : e?.effort ?? config.planner?.effort;
  const model = e?.model ?? config.planner?.model;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: 'plan', provider: 'claude', high };
}
// The builder config after the planner's EFFORT: "high" may move the builder only to its profile's own effortHigh (an existing
// profile rung), never beyond it and never down; nothing under opus, for a tiered feature (the tier decides), or when the
// builder is already there or a ladder step chose its config. Null: no change.
export function plannedEffort(config: Config, profile: string | null, f: Tiered, base: RoleConfig, effort: 'medium' | 'high' | undefined): { cfg: RoleConfig; rule: string } | null {
  const high = entryOf(config, profile, 'builder')?.effortHigh;
  if (effort !== 'high' || !high || f.tier || base.effort === high) return null;
  return { cfg: { ...base, effort: high }, rule: `planner: EFFORT high → the profile's effortHigh ${high} (from ${base.effort ?? '-'})` };
}

// ---- retry ladder ----

// Counted failures a fresh try may escalate for: the builder's implementation failed its review, or a gate failure a diagnosis
// attributed to its own code, in the current cycle (a person's retry, the observer's, a requirements update or a split starts
// a new one). The failure's recorded provenance decides; an older event without one counts only when its first line is a
// validated rejection (never a gate failure of unknown cause, never text inside an evaluator's unvalidated output).
// Uncounted stops, merges, setup, evaluator-run and builder-run failures and inline repairs never count. Capped by attempts.
const ELIGIBLE = new Set<FailureKind>(['review', 'gate-own']);
const LEGACY_REJECTION = /^(FAILED |CHEATING:|BLOCKING:)/;
const CYCLE_RESET = new Set(['retrying', 'observer-retry', 'acceptance-changed', 'superseded']);
export function ladderFailures(events: Pick<LogEvent, 'feature' | 'event' | 'detail' | 'stop' | 'attemptsReset' | 'cause' | 'failure'>[], id: string, attempts: number): number {
  let n = 0;
  for (const e of events) {
    if (e.feature !== id) continue;
    if (CYCLE_RESET.has(e.event) || (e.event === 'resumed' && e.attemptsReset)) n = 0;
    else if ((e.event === 'failed' || e.event === 'stuck') && e.stop?.counted && e.cause !== 'environment' && e.cause !== 'base-defect' &&
      (e.failure ? ELIGIBLE.has(e.failure) : LEGACY_REJECTION.test(e.detail || ''))) n++;
  }
  return Math.min(n, Math.max(0, attempts));
}
// The builder config a fresh try uses after `failures` counted failures: `steps` rungs up the profile's ladder from where the
// profile and tier put it. Null when the profile has no ladder, nothing failed, or the starting config is not a rung.
export function ladderStep(config: Config, profile: string | null, base: RoleConfig, failures: number): { cfg: RoleConfig; rule: string } | null {
  const ladder = profile == null || profile === OPUS ? undefined : profiles(config)[profile]?.ladder;
  if (!ladder?.length || failures <= 0) return null;
  const at = ladder.findIndex((r) => r.model === base.model && r.effort === base.effort);
  if (at < 0) return null;
  const to = Math.min(at + failures, ladder.length - 1), r = ladder[to]!, n = `${failures} counted failure${failures === 1 ? '' : 's'} this cycle`;
  return to === at ? { cfg: base, rule: `ladder: ${n}; already on the top rung (${r.model} ${r.effort}), no further approved escalation` }
    : { cfg: { ...base, model: r.model, effort: r.effort }, rule: `ladder: ${n} → ${r.model} ${r.effort} (from ${base.model} ${base.effort})` };
}

export interface RoleRow { role: ProfileRole; model: string | null; effort: string | null; effortHigh?: string; fromProfile: boolean }
// Every role as `profile` resolves it, for the dashboard tooltip, /api/state and `fact-os profile`. `agent`: the observer's
// agent config (what `observe --agent` would use).
export function roleTable(config: Config, profile: string | null, agent: RoleConfig | null = null): RoleRow[] {
  return PROFILE_ROLES.map((role) => {
    const r = resolveRole(config, profile, role, { agent }), e = entryOf(config, profile, role);
    return { role, model: r.model ?? null, effort: r.effort ?? null, ...(role === 'builder' && e?.effortHigh ? { effortHigh: e.effortHigh } : {}), fromProfile: !!e };
  });
}

// Problems with config.profiles, for doctor: an object of objects, known role keys, string fields, "opus" not redefined.
// Codex runs only the read-only roles: a provider is "claude" or, for the evaluator, "codex".
const providerProblems = (path: string, role: string, v: unknown): string[] =>
  v === 'claude' || (v === 'codex' && role === 'evaluator') ? [] : [`${path}.provider must be "claude"${role === 'evaluator' ? ' or "codex"' : ' (only the evaluator can use "codex")'}`];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MODEL_ORDER = ['haiku', 'sonnet', 'opus'];
function ladderProblems(path: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 2) return [`${path} must be an array of at least two {model, effort} rungs, weakest first`];
  const out: string[] = [], seen = new Set<string>();
  raw.forEach((r, i) => {
    if (!isObj(r) || typeof r.model !== 'string' || !r.model.trim() || typeof r.effort !== 'string' || !r.effort.trim() || Object.keys(r).some((k) => k !== 'model' && k !== 'effort'))
      return void out.push(`${path}[${i}] must be {model, effort} with non-empty strings`);
    if (seen.has(`${r.model} ${r.effort}`)) out.push(`${path}[${i}] repeats ${r.model} ${r.effort}`);
    seen.add(`${r.model} ${r.effort}`);
    if (!(EFFORTS as readonly string[]).includes(r.effort)) out.push(`${path}[${i}].effort must be one of ${EFFORTS.join(', ')}`);
  });
  // Weakest first: never a lower effort on the same model, never a lower known model (custom aliases are not ordered).
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1] as Rung, b = raw[i] as Rung;
    if (!isObj(a) || !isObj(b)) continue;
    const ea = EFFORTS.indexOf(a.effort as typeof EFFORTS[number]), eb = EFFORTS.indexOf(b.effort as typeof EFFORTS[number]);
    const ma = MODEL_ORDER.indexOf(a.model), mb = MODEL_ORDER.indexOf(b.model);
    if (a.model === b.model ? ea >= 0 && eb >= 0 && eb < ea : ma >= 0 && mb >= 0 && mb < ma) out.push(`${path}[${i}] (${b.model} ${b.effort}) is weaker than the rung before it (${a.model} ${a.effort})`);
  }
  return out;
}
function tierProblems(path: string, raw: unknown): string[] {
  if (!isObj(raw)) return [`${path} must be an object of {tier: {role: {model?, effort?, provider?}}}`];
  const out: string[] = [];
  for (const [tier, roles] of Object.entries(raw)) {
    if (!(TIERS as string[]).includes(tier)) { out.push(`${path}.${tier}: unknown tier (tiers: ${TIERS.join(', ')})`); continue; }
    if (!isObj(roles)) { out.push(`${path}.${tier} must be an object of roles`); continue; }
    for (const [role, e] of Object.entries(roles)) {
      if (!(TIER_ROLES as readonly string[]).includes(role)) { out.push(`${path}.${tier}.${role}: unknown role (tier roles: ${TIER_ROLES.join(', ')})`); continue; }
      if (!isObj(e)) { out.push(`${path}.${tier}.${role} must be an object {model?, effort?, provider?}`); continue; }
      for (const [k, v] of Object.entries(e)) {
        if (k === 'provider') out.push(...providerProblems(`${path}.${tier}.${role}`, role, v));
        else if (!['model', 'effort'].includes(k)) out.push(`${path}.${tier}.${role}.${k}: unknown field (model, effort, provider)`);
        else if (typeof v !== 'string' || !v.trim()) out.push(`${path}.${tier}.${role}.${k} must be a non-empty string`);
      }
    }
  }
  return out;
}

export function profileProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return ['config.profiles must be an object of {name: {role: {model?, effort?, effortHigh?}}}'];
  const out: string[] = [];
  for (const [name, p] of Object.entries(raw)) {
    if (RESERVED.includes(name)) { out.push(`config.profiles.${name}: "${name}" is reserved (each role's own config)`); continue; }
    if (!isObj(p)) { out.push(`config.profiles.${name} must be an object of roles`); continue; }
    for (const [role, e] of Object.entries(p)) {
      if (role === 'tiers') { out.push(...tierProblems(`config.profiles.${name}.tiers`, e)); continue; }
      if (role === 'ladder') { out.push(...ladderProblems(`config.profiles.${name}.ladder`, e)); continue; }
      if (!(PROFILE_ROLES as string[]).includes(role)) { out.push(`config.profiles.${name}.${role}: unknown role (roles: ${PROFILE_ROLES.join(', ')})`); continue; }
      if (!isObj(e)) { out.push(`config.profiles.${name}.${role} must be an object {model?, effort?, effortHigh?}`); continue; }
      for (const [k, v] of Object.entries(e)) {
        if (k === 'provider') { out.push(...providerProblems(`config.profiles.${name}.${role}`, role, v)); continue; }
        if (!['model', 'effort', 'effortHigh'].includes(k)) out.push(`config.profiles.${name}.${role}.${k}: unknown field (model, effort, effortHigh${k === 'permissionMode' ? '; permissionMode always comes from the role config' : ''})`);
        else if (typeof v !== 'string' || !v.trim()) out.push(`config.profiles.${name}.${role}.${k} must be a non-empty string`);
      }
      if ('effortHigh' in e && role !== 'builder' && role !== 'planner') out.push(`config.profiles.${name}.${role}.effortHigh: only the builder and the planner escalate`);
    }
  }
  return out;
}
