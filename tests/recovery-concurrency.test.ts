import { describe, expect, it } from 'vitest';
import type { TabMetadata } from '../src/core/types';
import { reconcileTabs } from '../src/background/recovery';
import { TabBusyError, TabOperationCoordinator } from '../src/background/tab-operation-coordinator';

function tab(id: number, overrides: Partial<TabMetadata> = {}): TabMetadata {
  return {
    id, url: `https://example.test/${id}`, title: `Tab ${id}`, windowId: 1, createdAt: 1,
    lastActiveAt: 10, accessCount: 2, focusDurationMs: 0, pinned: false, audible: false,
    active: false, loading: false, discarded: false, lifecycle: 'ACTIVE', lifecycleAt: 1,
    version: 4, referenceBit: false, queue: 2, lastQueueChangeAt: 1, ...overrides
  };
}

describe('worker restart recovery', () => {
  it('uses current Chrome tabs, removes closed tabs, and recovers interrupted discards', () => {
    const saved = {
      1: tab(1, { lifecycle: 'DISCARDING' }),
      2: tab(2, { lifecycle: 'DISCARDING' }),
      3: tab(3, { lifecycle: 'CANDIDATE' }),
      4: tab(4)
    };
    const recovered = reconcileTabs(saved, [
      tab(1, { discarded: true, lifecycle: 'DISCARDED', version: 5 }),
      tab(2, { lifecycle: 'ACTIVE', version: 5 }),
      tab(3, { lifecycle: 'CANDIDATE' }),
      tab(5, { title: 'New tab' })
    ], 100);

    expect(Object.keys(recovered).map(Number).sort()).toEqual([1, 2, 3, 5]);
    expect(recovered[1].lifecycle).toBe('DISCARDED');
    expect(recovered[2].lifecycle).toBe('ACTIVE');
    expect(recovered[3].lifecycle).toBe('ACTIVE');
    expect(recovered[5].title).toBe('New tab');
    expect(recovered[1].lifecycleAt).toBe(100);
  });

  it('keeps a loading restoration in RESTORING until Chrome reports completion', () => {
    const recovered = reconcileTabs(
      { 9: tab(9, { lifecycle: 'RESTORING' }) },
      [tab(9, { loading: true })],
      200
    );
    expect(recovered[9].lifecycle).toBe('RESTORING');
  });
});

describe('per-tab operation coordination', () => {
  it('shares a duplicate operation promise and invokes the browser task once', async () => {
    const coordinator = new TabOperationCoordinator();
    let finish!: (value: boolean) => void;
    let calls = 0;
    const task = () => { calls++; return new Promise<boolean>(resolve => { finish = resolve; }); };
    const first = coordinator.run(11, 'discard', task);
    const second = coordinator.run(11, 'discard', task);
    await Promise.resolve();
    expect(calls).toBe(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(coordinator.isBusy(11)).toBe(false);
  });

  it('rejects conflicting work on one tab, allows other tabs, and releases after failure', async () => {
    const coordinator = new TabOperationCoordinator();
    let finish!: () => void;
    const first = coordinator.run(12, 'discard', () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    await expect(coordinator.run(12, 'restore', async () => true)).rejects.toBeInstanceOf(TabBusyError);
    await expect(coordinator.run(13, 'restore', async () => true)).resolves.toBe(true);
    finish();
    await first;
    await expect(coordinator.run(12, 'restore', async () => true)).resolves.toBe(true);
  });

  it('releases its lock after a browser operation rejects', async () => {
    const coordinator = new TabOperationCoordinator();
    await expect(coordinator.run(14, 'discard', async () => { throw new Error('discard failed'); })).rejects.toThrow('discard failed');
    expect(coordinator.isBusy(14)).toBe(false);
    await expect(coordinator.run(14, 'discard', async () => true)).resolves.toBe(true);
  });
});
