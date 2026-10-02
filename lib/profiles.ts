// Model profiles: which model and effort each role runs with, switched at runtime in control.json (`profile`). "opus", the
// main mode, is each role's own config; any other profile overrides model/effort for the roles it names (permissionMode
// always stays the role's). Pure: no I/O, so the foreman, the observer, the CLI and the dashboard resolve roles alike.
import { PROFILE_ROLES, type Config, type Feature, type Profile, type ProfileEntry, type ProfileRole, type RoleConfig } from './types.ts';

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
  (role === 'observer' || role === 'curator' ? agent : role === 'resolver' ? config.resolver ?? config.builder : config[role]) || {};
const entryOf = (config: Config, profile: string | null, role: ProfileRole): ProfileEntry | undefined =>
  profile == null || profile === OPUS ? undefined : profiles(config)[profile]?.[role];

// The builder escalates to its profile's effortHigh on a risky feature; opus never escalates (its effort is the config's).
export const escalates = (config: Config, profile: string | null, feature?: Parameters<typeof isRisky>[0]): boolean =>
  !!feature && !!entryOf(config, profile, 'builder')?.effortHigh && isRisky(feature);

// The RoleConfig a launch actually uses. Base: the role's config (resolver falls back to builder, like claudeArgs always did;
// observer/curator take the observer's agent config, passed in by the caller). A profile naming the role overrides model and
// effort where its entry has them; permissionMode stays the base's. An unknown profile resolves like opus (callers validate).
export function resolveRole(config: Config, profile: string | null, role: ProfileRole, { feature, agent }: { feature?: Parameters<typeof isRisky>[0]; agent?: RoleConfig | null } = {}): RoleConfig {
  const base = baseOf(config, role, agent), e = entryOf(config, profile, role);
  if (!e) return { ...base };
  const effort = role === 'builder' && e.effortHigh && feature && isRisky(feature) ? e.effortHigh : e.effort ?? base.effort;
  return { ...base, ...(e.model ? { model: e.model } : {}), ...(effort ? { effort } : {}) };
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
export function profileProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isObj(raw)) return ['config.profiles must be an object of {name: {role: {model?, effort?, effortHigh?}}}'];
  const out: string[] = [];
  for (const [name, p] of Object.entries(raw)) {
    if (RESERVED.includes(name)) { out.push(`config.profiles.${name}: "${name}" is reserved (each role's own config)`); continue; }
    if (!isObj(p)) { out.push(`config.profiles.${name} must be an object of roles`); continue; }
    for (const [role, e] of Object.entries(p)) {
      if (!(PROFILE_ROLES as string[]).includes(role)) { out.push(`config.profiles.${name}.${role}: unknown role (roles: ${PROFILE_ROLES.join(', ')})`); continue; }
      if (!isObj(e)) { out.push(`config.profiles.${name}.${role} must be an object {model?, effort?, effortHigh?}`); continue; }
      for (const [k, v] of Object.entries(e)) {
        if (!['model', 'effort', 'effortHigh'].includes(k)) out.push(`config.profiles.${name}.${role}.${k}: unknown field (model, effort, effortHigh${k === 'permissionMode' ? '; permissionMode always comes from the role config' : ''})`);
        else if (typeof v !== 'string' || !v.trim()) out.push(`config.profiles.${name}.${role}.${k} must be a non-empty string`);
      }
      if ('effortHigh' in e && role !== 'builder') out.push(`config.profiles.${name}.${role}.effortHigh: only the builder escalates on risky features`);
    }
  }
  return out;
}
