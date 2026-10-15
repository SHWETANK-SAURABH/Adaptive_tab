import { describe, expect, it } from 'vitest';
import { eligible, protectionReason } from '../src/core/protection';
import { latencySummary } from '../src/evaluation/metrics';
import { demote, globalBoost, promote, updateQueue } from '../src/scheduler/mlfq';
import type { TabMetadata } from '../src/core/types';

const makeTab = (overrides: Partial<TabMetadata> = {}): TabMetadata => ({
  id: 1, url: 'https://example.com', title: 'Example', windowId: 1, createdAt: 0,
  lastActiveAt: 0, accessCount: 1, focusDurationMs: 0, pinned: false, audible: false,
  active: false, loading: false, discarded: false, lifecycle: 'ACTIVE', lifecycleAt: 0,
  version: 0, referenceBit: false, queue: 0, lastQueueChangeAt: 0, ...overrides
});

describe('protection and scheduling', () => {
  it('excludes active, pinned and audible tabs with visible reasons', () => {
    for (const [field, reason] of [['active', 'Active tab'], ['pinned', 'Pinned tab'], ['audible', 'Playing audio']] as const) {
      const tab = makeTab({ [field]: true });
      expect(protectionReason(tab)).toBe(reason);
      expect(eligible(tab)).toBe(false);
    }
    expect(eligible(makeTab())).toBe(true);
  });
  it('promotes interaction, demotes idle queues one level, and globally boosts', () => {
    const background = makeTab({ queue: 2, lastQueueChangeAt: 10 });
    expect(promote(background, 20).queue).toBe(1);
    expect(demote(background, 20).queue).toBe(3);
    expect(updateQueue(background, 10 + 1_800_000, [0, 300_000, 900_000, 1_800_000]).queue).toBe(3);
    expect(globalBoost([background], 100)[0].queue).toBe(0);
    expect(updateQueue(makeTab({ active: true, queue: 3 }), 100, [0, 1, 2, 3]).queue).toBe(0);
  });
});

describe('metrics', () => {
  it('returns p50, p95 and mean with nearest-rank percentiles', () => {
    expect(latencySummary([10, 20, 30, 40])).toEqual({ count: 4, p50: 20, p95: 40, mean: 25 });
    expect(latencySummary([])).toEqual({ count: 0, p50: undefined, p95: undefined, mean: undefined });
  });
});
