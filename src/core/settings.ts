import { DEFAULT_SETTINGS, type PolicyName, type Settings } from './types';

/** Inclusive bounds for numeric settings; the dashboard inputs use the same limits. */
export const SETTINGS_LIMITS = {
  tabBudget: { min: 1, max: 200 },
  workingSetMs: { min: 60_000, max: 86_400_000 },
  scanMinutes: { min: 1, max: 1440 },
  boostMinutes: { min: 1, max: 1440 },
  batchSize: { min: 1, max: 10 },
} as const;

const POLICIES: PolicyName[] = ['lru', 'working-set', 'clock'];

function clampInt(value: unknown, fallback: number, { min, max }: { min: number; max: number }): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * Merges an untrusted settings patch onto `base`. Fields with the wrong type (including NaN)
 * keep the base value; numbers outside SETTINGS_LIMITS are clamped.
 */
export function sanitizeSettings(patch: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const demotion = p.queueDemotionMs;
  return {
    policy: POLICIES.includes(p.policy as PolicyName) ? p.policy as PolicyName : base.policy,
    tabBudget: clampInt(p.tabBudget, base.tabBudget, SETTINGS_LIMITS.tabBudget),
    workingSetMs: clampInt(p.workingSetMs, base.workingSetMs, SETTINGS_LIMITS.workingSetMs),
    scanMinutes: clampInt(p.scanMinutes, base.scanMinutes, SETTINGS_LIMITS.scanMinutes),
    boostMinutes: clampInt(p.boostMinutes, base.boostMinutes, SETTINGS_LIMITS.boostMinutes),
    batchSize: clampInt(p.batchSize, base.batchSize, SETTINGS_LIMITS.batchSize),
    automatic: typeof p.automatic === 'boolean' ? p.automatic : base.automatic,
    dryRun: typeof p.dryRun === 'boolean' ? p.dryRun : base.dryRun,
    queueDemotionMs:
      Array.isArray(demotion) && demotion.length === base.queueDemotionMs.length
        && demotion.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        ? [...demotion]
        : base.queueDemotionMs,
  };
}
