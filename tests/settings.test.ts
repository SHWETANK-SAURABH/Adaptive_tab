import { describe, expect, it } from 'vitest';
import { SETTINGS_LIMITS, sanitizeSettings } from '../src/core/settings';
import { DEFAULT_SETTINGS } from '../src/core/types';

describe('settings sanitization', () => {
  it('clamps numbers to their limits and rounds to whole values', () => {
    const settings = sanitizeSettings({ tabBudget: 0, scanMinutes: 99_999, batchSize: 4.6, workingSetMs: 1, boostMinutes: -1 });
    expect(settings).toMatchObject({
      tabBudget: SETTINGS_LIMITS.tabBudget.min,
      scanMinutes: SETTINGS_LIMITS.scanMinutes.max,
      batchSize: 5,
      workingSetMs: SETTINGS_LIMITS.workingSetMs.min,
      boostMinutes: SETTINGS_LIMITS.boostMinutes.min
    });
  });

  it('keeps the base value for fields with the wrong type', () => {
    const base = { ...DEFAULT_SETTINGS, tabBudget: 15, policy: 'clock' as const, automatic: true };
    const settings = sanitizeSettings({ tabBudget: NaN, scanMinutes: '10', policy: 'fifo', automatic: 'yes', queueDemotionMs: [1, -2, 3, 4] }, base);
    expect(settings).toEqual(base);
  });

  it('applies valid fields and ignores unknown ones', () => {
    const settings = sanitizeSettings({ policy: 'working-set', dryRun: false, queueDemotionMs: [0, 1, 2, 3], extra: 1 });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, policy: 'working-set', dryRun: false, queueDemotionMs: [0, 1, 2, 3] });
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
});
