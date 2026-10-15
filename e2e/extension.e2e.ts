/// <reference types="node" />
// Real-browser checks of the built extension (dist/): Chrome event ordering, service-worker
// termination and restart, recovery from storage, and tab closing/reopening. Run with `npm run test:e2e`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser, launch, startFixtures, waitUntil, type Fixtures, type Session } from './harness';

const browserPath = findBrowser();
if (!browserPath) console.warn('Skipping e2e: no Chrome, Edge or Chromium found (set ADAPTIVETAB_BROWSER).');

describe.skipIf(!browserPath)(`AdaptiveTab in ${browserPath}`, () => {
  let fixtures: Fixtures;
  let s: Session;
  const tabTitles = async () => (await s.ext(() => chrome.tabs.query({}).then(tabs => tabs.map(t => t.title ?? '')))).filter(t => t.startsWith('Fixture'));
  const tracked = async (id: number) => (await s.state()).tabs[id];

  beforeAll(async () => { fixtures = await startFixtures(); });
  afterAll(async () => { await fixtures?.close(); });
  beforeEach(async () => { s = (await launch()).session!; });
  afterEach(async () => { await s?.close(); });

  it('reconciles open tabs and creates both alarms', async () => {
    const one = await s.openTab(fixtures.url(1));
    const two = await s.openTab(fixtures.url(2));
    await waitUntil(async () => (await tracked(one))?.title === 'Fixture 1' && (await tracked(two))?.title === 'Fixture 2', 'both tabs to be tracked with titles');
    const alarms = await s.ext(() => chrome.alarms.getAll().then(all => all.map(a => [a.name, a.periodInMinutes]).sort()));
    expect(alarms).toEqual([['adaptive-tab-boost', 30], ['adaptive-tab-scan', 5]]);
  });

  it('closes a real tab on Discard and reopens it at its old position, recording restore latency', async () => {
    await s.openTab(fixtures.url(1));
    const target = await s.openTab(fixtures.url(2));
    await s.openTab(fixtures.url(3));
    const index = await s.ext(id => chrome.tabs.get(id).then(t => t.index), target);
    await waitUntil(async () => (await tracked(target))?.title === 'Fixture 2', 'the tab to be tracked');

    expect(await s.send({ type: 'DISCARD', tabId: target })).toEqual({ success: true });
    expect(await tabTitles()).toEqual(['Fixture 1', 'Fixture 3']);
    const afterClose = await s.state();
    expect(afterClose.tabs[target]).toBeUndefined();
    expect(afterClose.closed).toMatchObject([{ id: target, title: 'Fixture 2', index }]);
    // Chrome's onRemoved for a tab AdaptiveTab closed must not be logged a second time as a user close.
    expect(afterClose.events.filter((e: any) => e.tabId === target).map((e: any) => e.type)).toEqual(['discard']);

    expect(await s.send({ type: 'REOPEN', key: afterClose.closed[0].key })).toEqual({ success: true });
    await waitUntil(async () => (await tabTitles()).join() === 'Fixture 1,Fixture 2,Fixture 3', 'the tab to come back in its old position');
    const samples = await waitUntil(async () => { const m = (await s.state()).metrics.restorationLatenciesMs; return m.length === 1 && m; }, 'a restore latency sample');
    expect(samples[0]).toBeGreaterThan(0);
    expect((await s.state()).closed).toEqual([]);
  });

  it('refuses to close the active tab and pinned tabs, giving the reason', async () => {
    const driverTab = await s.ext(() => chrome.tabs.getCurrent().then(t => t!.id!));
    const pinned = await s.openTab(fixtures.url(1));
    await s.ext(id => chrome.tabs.update(id, { pinned: true }).then(() => undefined), pinned);
    await waitUntil(async () => (await tracked(pinned))?.pinned, 'the pin to be observed');

    expect(await s.send({ type: 'DISCARD', tabId: driverTab })).toEqual({ success: false, reason: 'Active tab' });
    expect(await s.send({ type: 'DISCARD', tabId: pinned })).toEqual({ success: false, reason: 'Pinned tab' });
    expect(await tabTitles()).toEqual(['Fixture 1']);
  });

  it('recovers persisted state when Chrome stops the worker and a tab event restarts it', async () => {
    await s.send({ type: 'UPDATE_SETTINGS', settings: { tabBudget: 7, policy: 'clock' } });
    const closing = await s.openTab(fixtures.url(1));
    await s.openTab(fixtures.url(2));
    expect((await s.send({ type: 'DISCARD', tabId: closing })).success).toBe(true);
    const before = await s.workerTimeOrigin();

    await s.stopWorker();
    expect(s.workerRunning()).toBe(false);
    // Opening a tab fires tabs.onCreated, which is what wakes the worker; no message is sent before it is back.
    const opened = await s.ext(url => chrome.tabs.create({ url, active: false }).then(t => t.id!), fixtures.url(3));
    await waitUntil(() => s.workerRunning(), 'the tab event to restart the worker');
    expect(await s.workerTimeOrigin()).toBeGreaterThan(before);

    const state = await waitUntil(async () => { const st = await s.state(); return st.tabs[opened]?.title === 'Fixture 3' && st; }, 'the new tab to be tracked after restart');
    expect(state.settings).toMatchObject({ tabBudget: 7, policy: 'clock' });
    expect(state.closed.map((c: any) => c.title)).toEqual(['Fixture 1']);
    expect(Object.values(state.tabs).map((t: any) => t.title).filter((t: string) => t.startsWith('Fixture')).sort()).toEqual(['Fixture 2', 'Fixture 3']);
  });

  it('resolves an interrupted close and drops tabs that vanished while the worker was stopped', async () => {
    const tab = await s.openTab(fixtures.url(1));
    await waitUntil(async () => (await tracked(tab))?.title === 'Fixture 1', 'the tab to be tracked');
    await s.stopWorker();
    await s.ext(async id => {
      const { adaptiveTabState: saved } = await chrome.storage.local.get('adaptiveTabState') as any;
      saved.tabs[id].lifecycle = 'DISCARDING';
      saved.tabs[999_999] = { ...saved.tabs[id], id: 999_999, title: 'Gone', lifecycle: 'DISCARDING' };
      await chrome.storage.local.set({ adaptiveTabState: saved });
    }, tab);

    const state = await s.state();
    expect(state.tabs[tab].lifecycle).toBe('ACTIVE');
    expect(state.tabs[999_999]).toBeUndefined();
    expect((await s.send({ type: 'DISCARD', tabId: tab })).success).toBe(true);
  });

  it("keeps each window's active tab active and protected", async () => {
    const other = await s.ext(url => chrome.windows.create({ url, focused: true }).then(w => w.tabs![0].id!), fixtures.url('W2'));
    await waitUntil(async () => (await tracked(other))?.title === 'Fixture W2', 'the second window tab to be tracked');
    const background = await s.openTab(fixtures.url(1));
    await s.ext(id => chrome.tabs.update(id, { active: true }).then(() => undefined), background);
    await waitUntil(async () => (await tracked(background))?.active, 'activation in window 1 to be observed');

    const state = await s.state();
    expect(state.tabs[other]).toMatchObject({ active: true, protectionReason: 'Active tab' });
    await s.send({ type: 'UPDATE_SETTINGS', settings: { batchSize: 10 } });
    const preview = await s.send<{ candidates: { id: number }[] }>({ type: 'SCAN' });
    expect(preview.candidates.map(c => c.id)).not.toContain(other);
    expect(preview.candidates.map(c => c.id)).not.toContain(background);
  });

  it('follows a tab Chrome itself discarded to its new id and restores it, recording restore latency', async () => {
    const tab = await s.openTab(fixtures.url(1));
    const before = await waitUntil(async () => { const t = await tracked(tab); return t?.title === 'Fixture 1' && t; }, 'the tab to be tracked');
    // Chrome replaces a discarded tab with a new id and fires tabs.onReplaced.
    const replaced = await s.ext(id => chrome.tabs.discard(id).then(t => t!.id!), tab);
    const after = await waitUntil(async () => {
      const st = await s.state();
      return (replaced === tab || !st.tabs[tab]) && st.tabs[replaced]?.lifecycle === 'DISCARDED' && st.tabs[replaced];
    }, 'the discard to be observed on the new id with the old id dropped');
    expect(after).toMatchObject({ title: 'Fixture 1', discarded: true, createdAt: before.createdAt, accessCount: before.accessCount });

    expect((await s.send({ type: 'RESTORE', tabId: replaced })).success).toBe(true);
    await waitUntil(async () => (await s.state()).metrics.restorationLatenciesMs.length === 1, 'a restore latency sample');
    expect(await tracked(replaced)).toMatchObject({ discarded: false, lifecycle: 'ACTIVE' });
  });

  it('closes the least recently used tabs above the budget when the scan alarm fires', async () => {
    for (const id of [1, 2, 3, 4]) await s.openTab(fixtures.url(id));
    await waitUntil(async () => Object.values((await s.state()).tabs).filter((t: any) => t.title?.startsWith('Fixture')).length === 4, 'all tabs to be tracked');
    await s.send({ type: 'UPDATE_SETTINGS', settings: { automatic: true, dryRun: false, tabBudget: 3, batchSize: 5, policy: 'lru' } });
    // Replace the 5-minute periodic alarm with a one-shot alarm under the same name so the real alarm path runs now.
    await s.ext(() => chrome.alarms.create('adaptive-tab-scan', { when: Date.now() + 100 }));

    // 5 resident tabs (4 fixtures + the active dashboard) against a budget of 3: the two oldest fixtures close.
    await waitUntil(async () => (await tabTitles()).length === 2, 'the scan to close two tabs');
    expect(await tabTitles()).toEqual(['Fixture 3', 'Fixture 4']);
    expect((await s.state()).closed.map((c: any) => c.title).sort()).toEqual(['Fixture 1', 'Fixture 2']);
  });
});
