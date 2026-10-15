import { describe, expect, it } from 'vitest';
import { replayTrace, syntheticTrace } from '../src/evaluation/trace-replay';
import { evictionQuality } from '../src/evaluation/metrics';

describe('deterministic evaluation baselines', () => {
  it('repeats seeded synthetic traces exactly', () => {
    expect(syntheticTrace(50, 200, 42)).toEqual(syntheticTrace(50, 200, 42));
  });
  it('keeps fixed-timeout and Belady simulation separate from physical measurements', () => {
    const trace = [1, 2, 3, 1, 4, 2, 5, 1, 2];
    expect(replayTrace(trace, 3, 'fixed-timeout', 1).policy).toBe('fixed-timeout');
    expect(replayTrace(trace, 3, 'belady').misses).toBeLessThanOrEqual(replayTrace(trace, 3, 'lru').misses);
  });
  it('computes avoidable evictions against an explicit future-reference horizon', () => {
    const quality = evictionQuality([1, 2, 3, 1, 4, 2], [
      { victimId: 1, referenceIndex: 2 },
      { victimId: 3, referenceIndex: 4 }
    ], 2);
    expect(quality).toEqual({ evaluatedEvictions: 2, avoidableEvictions: 1, avoidableEvictionRate: 0.5, evictionAccuracy: 0.5 });
    expect(evictionQuality([1], [], 5).evictionAccuracy).toBeUndefined();
  });
});
