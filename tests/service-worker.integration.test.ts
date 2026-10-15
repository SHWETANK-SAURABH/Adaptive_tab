import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeEvent() {
  let handler: ((...args: any[]) => any) | undefined;
  return {
    addListener: vi.fn((listener: (...args: any[]) => any) => { handler = listener; }),
    fire: (...args: any[]) => handler?.(...args),
    get handler() { return handler; }
  };
}

function copy<T>(value: T): T { return structuredClone(value); }

function makeTab(id: number, active: boolean) {
  return { id, windowId: 1, index: id - 1, url: `https://example.test/${id}`, title: `Tab ${id}`, active, pinned: false, audible: false, discarded: false, status: 'complete' };
}

function makeChrome(tabs: ReturnType<typeof makeTab>[], storage: Record<string, unknown> = {}) {
  const tabCreated = makeEvent();
  const tabActivated = makeEvent();
  const tabUpdated = makeEvent();
  const tabRemoved = makeEvent();
  const alarmEvent = makeEvent();
  const installed = makeEvent();
  const startup = makeEvent();
  const message = makeEvent();
  const data = new Map(Object.entries(storage));
  const alarms = new Map<string, { name: string; periodInMinutes?: number }>();
  const api = {
    runtime: { onInstalled: installed, onStartup: startup, onMessage: message },
    windows: { update: vi.fn(async (windowId: number, info: { focused?: boolean }) => ({ id: windowId, ...info })) },
    alarms: {
      create: vi.fn(async (name: string, info: { periodInMinutes?: number }) => { alarms.set(name, { name, ...info }); }),
      get: vi.fn(async (name: string) => alarms.get(name)),
      onAlarm: alarmEvent
    },
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: copy(data.get(key)) })),
      set: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, copy(value)); })
    } },
    tabs: {
      onCreated: tabCreated, onActivated: tabActivated, onUpdated: tabUpdated, onRemoved: tabRemoved,
      query: vi.fn(async () => copy(tabs)),
      get: vi.fn(async (id: number) => { const found = tabs.find(tab => tab.id === id); if (!found) throw new Error('No tab'); return copy(found); }),
      discard: vi.fn(async (id: number) => { const found = tabs.find(tab => tab.id === id); if (!found) throw new Error('No tab'); found.discarded = true; found.active = false; }),
      remove: vi.fn(async (id: number) => { const at = tabs.findIndex(tab => tab.id === id); if (at < 0) throw new Error('No tab'); tabs.splice(at, 1); tabRemoved.fire(id); }),
      create: vi.fn(async (props: { url?: string; windowId?: number; index?: number; active?: boolean }) => {
        const created = { ...makeTab(Math.max(0, ...tabs.map(tab => tab.id)) + 1, !!props.active), url: props.url ?? '', windowId: props.windowId ?? 1, index: props.index ?? tabs.length, status: 'loading' };
        if (created.active) for (const tab of tabs) tab.active = false;
        tabs.push(created);
        return copy(created);
      }),
      update: vi.fn(async (id: number, changes: { active?: boolean }) => { const found = tabs.find(tab => tab.id === id); if (!found) throw new Error('No tab'); if (changes.active) { for (const tab of tabs) tab.active = false; found.active = true; } return copy(found); })
    }
  };
  return { api, tabs, data, alarms, message, tabActivated, tabUpdated, tabRemoved, installed, startup };
}

async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); }

describe('service worker integration', () => {
  beforeEach(() => vi.resetModules());

  it('tracks candidates, closes discarded tabs, reopens them, and records scan/restore measurements', async () => {
    const env = makeChrome([makeTab(1, true), makeTab(2, false)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));

    const initial = await send({ type: 'GET_STATE' });
    expect(Object.keys(initial.state.tabs).map(Number)).toEqual([1, 2]);
    await send({ type: 'UPDATE_SETTINGS', settings: { policy: 'clock', tabBudget: 1 } });
    expect((await send({ type: 'GET_STATE' })).state.settings).toMatchObject({ policy: 'clock', tabBudget: 1 });
    const preview = await send({ type: 'SCAN' });
    expect(preview.candidates.map((item: { id: number }) => item.id)).toEqual([2]);
    expect(env.data.get('adaptiveTabState')).toMatchObject({ metrics: { scanDurationsMs: expect.arrayContaining([expect.any(Number)]) } });

    const [discard, duplicateDiscard] = await Promise.all([
      send({ type: 'DISCARD', tabId: 2 }), send({ type: 'DISCARD', tabId: 2 })
    ]);
    expect(discard.success).toBe(true);
    expect(duplicateDiscard.success).toBe(true);
    expect(env.api.tabs.remove).toHaveBeenCalledTimes(1);
    expect(env.api.tabs.discard).not.toHaveBeenCalled();
    await flush();
    const closedState = (await send({ type: 'GET_STATE' })).state;
    expect(closedState.tabs[2]).toBeUndefined();
    expect(closedState.closed).toHaveLength(1);
    expect(closedState.closed[0]).toMatchObject({ id: 2, url: 'https://example.test/2', title: 'Tab 2', windowId: 1, index: 1 });
    expect(closedState.events.filter((e: { type: string }) => e.type === 'removed')).toHaveLength(0);

    expect((await send({ type: 'REOPEN', key: closedState.closed[0].key })).success).toBe(true);
    expect(env.api.tabs.create).toHaveBeenCalledWith({ url: 'https://example.test/2', windowId: 1, index: 1, active: true });
    const reopened = env.tabs.find(tab => tab.url === 'https://example.test/2')!;
    expect((await send({ type: 'GET_STATE' })).state.tabs[reopened.id]).toMatchObject({ lifecycle: 'RESTORING', accessCount: 2 });
    reopened.status = 'complete';
    await env.tabUpdated.fire(reopened.id, { status: 'complete' }, copy(reopened));
    await flush();

    const finalState = (await send({ type: 'GET_STATE' })).state;
    expect(finalState.closed).toHaveLength(0);
    expect(finalState.tabs[reopened.id].lifecycle).toBe('ACTIVE');
    expect(finalState.metrics.restorationLatenciesMs).toHaveLength(1);
    expect(finalState.metrics.restorationLatenciesMs[0]).toBeGreaterThanOrEqual(0);
  });

  it('refuses protected tabs and keeps a tab usable when closing fails', async () => {
    const env = makeChrome([makeTab(1, true), makeTab(2, false)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));

    expect(await send({ type: 'DISCARD', tabId: 1 })).toEqual({ success: false, reason: 'Active tab' });
    expect(env.api.tabs.remove).not.toHaveBeenCalled();

    env.api.tabs.remove.mockRejectedValueOnce(new Error('Tabs cannot be edited right now'));
    const failed = await send({ type: 'DISCARD', tabId: 2 });
    expect(failed.success).toBe(false);
    expect(failed.reason).toContain('Tabs cannot be edited right now');
    const state = (await send({ type: 'GET_STATE' })).state;
    expect(state.tabs[2].lifecycle).toBe('ACTIVE');
    expect(state.closed).toHaveLength(0);

    expect((await send({ type: 'DISCARD', tabId: 2 })).success).toBe(true);
    expect(env.api.tabs.remove).toHaveBeenCalledTimes(2);
  });

  it('restores protection reasons during startup recovery', async () => {
    const pinned = { ...makeTab(2, false), pinned: true };
    const saved = { adaptiveTabState: {
      tabs: { 1: { ...makeTab(1, true), createdAt: 1, lastActiveAt: 1, accessCount: 1, focusDurationMs: 0, lifecycle: 'ACTIVE', lifecycleAt: 1, version: 3, referenceBit: false, queue: 0, lastQueueChangeAt: 1, protectionReason: 'Active tab' } },
      settings: {}, events: [], decisions: [], metrics: { scanDurationsMs: [], restorationLatenciesMs: [] }
    } };
    const env = makeChrome([makeTab(1, true), pinned, makeTab(3, false)], saved);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const { tabs } = (await new Promise<any>(resolve => env.message.handler!({ type: 'GET_STATE' }, {}, resolve))).state;
    expect(tabs[1].protectionReason).toBe('Active tab');
    expect(tabs[2].protectionReason).toBe('Pinned tab');
    expect(tabs[3].protectionReason).toBeUndefined();
  });

  it('keeps the active tab of other windows active and protected', async () => {
    const env = makeChrome([makeTab(1, true), makeTab(2, false), { ...makeTab(3, true), windowId: 2 }, { ...makeTab(4, false), windowId: 2 }]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));
    await send({ type: 'GET_STATE' });

    env.tabs[2].active = false;
    env.tabs[3].active = true;
    await env.tabActivated.fire({ tabId: 4, windowId: 2 });
    await flush();

    const { tabs } = (await send({ type: 'GET_STATE' })).state;
    expect(tabs[1]).toMatchObject({ active: true, protectionReason: 'Active tab' });
    expect(tabs[3]).toMatchObject({ active: false });
    expect(tabs[3].protectionReason).toBeUndefined();
    expect(tabs[4]).toMatchObject({ active: true, protectionReason: 'Active tab' });
    await send({ type: 'UPDATE_SETTINGS', settings: { batchSize: 10 } });
    expect((await send({ type: 'SCAN' })).candidates.map((c: { id: number }) => c.id).sort()).toEqual([2, 3]);
  });

  it('continues an automatic scan when closing one candidate throws', async () => {
    const env = makeChrome([makeTab(1, true), makeTab(2, false), makeTab(3, false)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));
    await send({ type: 'UPDATE_SETTINGS', settings: { automatic: true, dryRun: false, tabBudget: 1, batchSize: 2 } });

    env.api.tabs.get.mockRejectedValueOnce(new Error('Tab 2 is busy'));
    await env.api.alarms.onAlarm.fire({ name: 'adaptive-tab-scan' });
    await flush();

    expect(env.api.tabs.remove).toHaveBeenCalledTimes(1);
    expect(env.api.tabs.remove).toHaveBeenCalledWith(3);
    const state = (await send({ type: 'GET_STATE' })).state;
    expect(state.events.some((e: { type: string; message: string }) => e.type === 'error' && e.message.includes('Automatic close skipped') && e.message.includes('Tab 2 is busy'))).toBe(true);
  });

  it('sanitizes setting updates and only recreates alarms whose interval changed', async () => {
    const env = makeChrome([makeTab(1, true)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));
    await send({ type: 'GET_STATE' });
    expect([...env.alarms.values()]).toEqual([
      { name: 'adaptive-tab-scan', periodInMinutes: 5 },
      { name: 'adaptive-tab-boost', periodInMinutes: 30 }
    ]);
    env.api.alarms.create.mockClear();

    const { settings } = (await send({ type: 'UPDATE_SETTINGS', settings: { scanMinutes: 0, tabBudget: NaN, batchSize: -3, policy: 'fifo', dryRun: 'no' } })).state;
    expect(settings).toMatchObject({ scanMinutes: 1, tabBudget: 20, batchSize: 1, policy: 'lru', dryRun: true });
    expect(env.api.alarms.create).toHaveBeenCalledTimes(1);
    expect(env.api.alarms.create).toHaveBeenCalledWith('adaptive-tab-scan', { periodInMinutes: 1 });

    env.api.alarms.create.mockClear();
    await send({ type: 'UPDATE_SETTINGS', settings: { tabBudget: 12 } });
    expect(env.api.alarms.create).not.toHaveBeenCalled();
  });

  it('recreates missing alarms, sanitizes saved settings, and trims stored decisions on startup', async () => {
    const decisions = Array.from({ length: 1000 }, (_, i) => ({ tabId: 1, reason: `r${i}`, at: i }));
    const saved = { adaptiveTabState: {
      tabs: {}, settings: { scanMinutes: -5, boostMinutes: 'often', tabBudget: 9999 },
      events: [], decisions, metrics: { scanDurationsMs: [], restorationLatenciesMs: [] }
    } };
    const env = makeChrome([makeTab(1, true)], saved);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const { state } = await new Promise<any>(resolve => env.message.handler!({ type: 'GET_STATE' }, {}, resolve));
    expect(state.settings).toMatchObject({ scanMinutes: 1, boostMinutes: 30, tabBudget: 200 });
    expect(state.decisions).toHaveLength(300);
    expect(state.decisions[0].reason).toBe('r0');
    expect(env.alarms.get('adaptive-tab-scan')).toEqual({ name: 'adaptive-tab-scan', periodInMinutes: 1 });
    expect(env.alarms.get('adaptive-tab-boost')).toEqual({ name: 'adaptive-tab-boost', periodInMinutes: 30 });
  });

  it('caps the decision log during repeated scans', async () => {
    const env = makeChrome(Array.from({ length: 12 }, (_, i) => makeTab(i + 1, i === 0)));
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));
    await send({ type: 'UPDATE_SETTINGS', settings: { batchSize: 10 } });
    for (let i = 0; i < 40; i++) await send({ type: 'SCAN' });
    expect((await send({ type: 'GET_STATE' })).state.decisions).toHaveLength(300);
  });

  it('brings the window to the front when restoring or reopening a tab', async () => {
    const env = makeChrome([makeTab(1, true), { ...makeTab(2, false), windowId: 2, discarded: true }, makeTab(3, false)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));

    expect((await send({ type: 'RESTORE', tabId: 2 })).success).toBe(true);
    expect(env.api.windows.update).toHaveBeenLastCalledWith(2, { focused: true });

    await send({ type: 'DISCARD', tabId: 3 });
    const { closed } = (await send({ type: 'GET_STATE' })).state;
    env.api.windows.update.mockRejectedValueOnce(new Error('No window with id: 1.'));
    expect((await send({ type: 'REOPEN', key: closed[0].key })).success).toBe(true);
    expect(env.api.windows.update).toHaveBeenLastCalledWith(1, { focused: true });
  });

  it('reopens in the current window when the original window is gone', async () => {
    const env = makeChrome([makeTab(1, true), makeTab(2, false)]);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const send = (payload: object) => new Promise<any>(resolve => env.message.handler!(payload, {}, resolve));

    await send({ type: 'DISCARD', tabId: 2 });
    const { closed } = (await send({ type: 'GET_STATE' })).state;
    env.api.tabs.create.mockRejectedValueOnce(new Error('No window with id: 1.'));
    expect((await send({ type: 'REOPEN', key: closed[0].key })).success).toBe(true);
    expect(env.api.tabs.create).toHaveBeenLastCalledWith({ url: 'https://example.test/2', active: true });
    expect((await send({ type: 'REOPEN', key: closed[0].key }))).toEqual({ success: false, reason: 'Closed tab record not found' });
  });

  it('recovers an interrupted discard from the live Chrome tab state', async () => {
    const tab = makeTab(7, false);
    const saved = { adaptiveTabState: {
      tabs: { 7: { ...makeTab(7, false), createdAt: 1, lastActiveAt: 1, accessCount: 1, focusDurationMs: 0, lifecycle: 'DISCARDING', lifecycleAt: 1, version: 9, referenceBit: false, queue: 2, lastQueueChangeAt: 1 } },
      settings: {}, events: [], decisions: [], metrics: { scanDurationsMs: [], restorationLatenciesMs: [] }
    } };
    const env = makeChrome([tab], saved);
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: env.api });
    await import('../src/background/service-worker');
    const state = await new Promise<any>(resolve => env.message.handler!({ type: 'GET_STATE' }, {}, resolve));
    expect(state.state.tabs[7].lifecycle).toBe('ACTIVE');
  });
});
