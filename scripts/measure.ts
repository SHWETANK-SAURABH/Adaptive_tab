/// <reference types="node" />
// Real-browser memory and CPU experiment for AdaptiveTab. See docs/MEASUREMENTS.md for the method.
// Usage: npm run measure -- [--tabs 12] [--mb 40] [--close 6] [--repeats 3] [--settle 5] [--idle 10] [--scans 20] [--headed]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import type { CDPSession, Page } from 'puppeteer-core';
import { findBrowser, launch, startFixtures, waitUntil, type Fixtures } from '../e2e/harness';

const { values: flags } = parseArgs({ options: {
  tabs: { type: 'string', default: '12' }, mb: { type: 'string', default: '40' }, close: { type: 'string', default: '6' },
  repeats: { type: 'string', default: '3' }, settle: { type: 'string', default: '5' }, idle: { type: 'string', default: '10' },
  scans: { type: 'string', default: '20' }, headed: { type: 'boolean', default: false }, out: { type: 'string', default: 'measurements' },
} });
const P = { tabs: +flags.tabs, mb: +flags.mb, close: +flags.close, repeats: +flags.repeats, settleS: +flags.settle, idleS: +flags.idle, scans: +flags.scans, headless: !flags.headed };
if (P.close > P.tabs - 1) throw new Error('--close must leave at least one tab open (the active tab is never closed)');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const MiB = 2 ** 20;

interface Sample { workingSetMiB: number; privateMiB?: number; cpuSeconds: number; processes: number; }

/** Resident memory per process from the OS: Windows working set and private bytes; RSS elsewhere. Processes that already exited are skipped. */
function osMemory(pids: number[]): { workingSet: number; private?: number } {
  if (process.platform === 'win32') {
    const json = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress; exit 0`], { encoding: 'utf8' });
    const rows: { WorkingSet64: number; PrivateMemorySize64: number }[] = [JSON.parse(json || '[]')].flat();
    return { workingSet: rows.reduce((a, r) => a + r.WorkingSet64, 0), private: rows.reduce((a, r) => a + r.PrivateMemorySize64, 0) };
  }
  if (process.platform === 'linux') {
    let total = 0;
    for (const pid of pids) { try { total += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; } catch { /* exited */ } }
    return { workingSet: total };
  }
  const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return { workingSet: out.split('\n').reduce((a, line) => a + (Number(line.trim()) || 0) * 1024, 0) };
}

/** One reading over every process Chrome reports for this browser instance (browser, renderers, GPU, utilities). */
async function sample(cdp: CDPSession): Promise<Sample> {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const memory = osMemory(processInfo.map(p => p.id));
  return { workingSetMiB: memory.workingSet / MiB, privateMiB: memory.private === undefined ? undefined : memory.private / MiB, cpuSeconds: processInfo.reduce((a, p) => a + p.cpuTime, 0), processes: processInfo.length };
}

/** Median of three readings one second apart, after letting the browser settle. */
async function settledSample(cdp: CDPSession): Promise<Sample> {
  await sleep(P.settleS * 1000);
  const readings: Sample[] = [];
  for (let i = 0; i < 3; i++) { readings.push(await sample(cdp)); if (i < 2) await sleep(1000); }
  return {
    workingSetMiB: median(readings.map(r => r.workingSetMiB)),
    privateMiB: readings[0].privateMiB === undefined ? undefined : median(readings.map(r => r.privateMiB!)),
    cpuSeconds: readings[2].cpuSeconds, processes: readings[2].processes,
  };
}

/** Opens the fixture tabs in the background through CDP, without attaching DevTools to them, and waits until each has allocated its memory. */
async function openFixtureTabs(cdp: CDPSession, fixtures: Fixtures): Promise<void> {
  fixtures.reset();
  for (let i = 1; i <= P.tabs; i++) {
    await cdp.send('Target.createTarget', { url: fixtures.url(i, { mb: P.mb, ownSite: true }), background: true });
    await waitUntil(() => fixtures.loaded(i), `fixture ${i} to load`, 30_000);
  }
}

async function quietDashboard(driver: Page, extensionId: string) {
  await driver.goto(`chrome-extension://${extensionId}/index.html`);
  await driver.evaluate(() => { const last = setInterval(() => {}, 1e9) as unknown as number; for (let id = 0; id <= last; id++) clearInterval(id); });
}

/** Ids of the `count` lowest-id fixture tabs that are not active (the most recently opened fixture is active). */
const fixtureTabs = (driver: Page) => driver.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.filter(t => t.title?.startsWith('Fixture'))));
const closableFixtureTabs = (driver: Page, count: number) => driver.evaluate(n => chrome.tabs.query({}).then(tabs => tabs.filter(t => t.title?.startsWith('Fixture') && !t.active).map(t => t.id!).sort((a, b) => a - b).slice(0, n)), count);

interface RunResult { condition: string; [metric: string]: number | string | undefined; }

async function runBaseline(fixtures: Fixtures): Promise<RunResult> {
  const { browser } = await launch({ extension: false, headless: P.headless, attachToWebPages: false });
  try {
    const cdp = await browser.target().createCDPSession();
    await openFixtureTabs(cdp, fixtures);
    const loaded = await settledSample(cdp);
    await sleep(P.idleS * 1000);
    const idle = await sample(cdp);
    return { condition: 'baseline (no extension)', workingSetMiB: loaded.workingSetMiB, privateMiB: loaded.privateMiB, processes: loaded.processes, idleCpuMsPerS: (idle.cpuSeconds - loaded.cpuSeconds) * 1000 / P.idleS };
  } finally { await browser.close(); }
}

async function runExtensionIdleAndScans(fixtures: Fixtures): Promise<RunResult> {
  const { browser, session } = await launch({ headless: P.headless, attachToWebPages: false });
  try {
    const cdp = await browser.target().createCDPSession();
    await openFixtureTabs(cdp, fixtures);
    // Same tab set as the baseline: the driver tab shows about:blank while measuring, and the worker is running.
    await session!.driver.goto('about:blank');
    const loaded = await settledSample(cdp);
    await sleep(P.idleS * 1000);
    const idle = await sample(cdp);
    const idleRate = (idle.cpuSeconds - loaded.cpuSeconds) / P.idleS;

    await quietDashboard(session!.driver, session!.extensionId);
    const before = await sample(cdp); const started = Date.now();
    for (let i = 0; i < P.scans; i++) await session!.send({ type: 'SCAN' });
    const wall = (Date.now() - started) / 1000; const after = await sample(cdp);
    const scanCpuMs = Math.max(0, (after.cpuSeconds - before.cpuSeconds - idleRate * wall) * 1000) / P.scans;
    const scanMs: number[] = (await session!.state()).metrics.scanDurationsMs;
    return { condition: 'extension loaded (worker running)', workingSetMiB: loaded.workingSetMiB, privateMiB: loaded.privateMiB, processes: loaded.processes, idleCpuMsPerS: idleRate * 1000, scanCpuMsEach: scanCpuMs, scanWallMsP50: median(scanMs), scanWallMsMax: Math.max(...scanMs) };
  } finally { await browser.close(); }
}

async function runReclaim(fixtures: Fixtures, how: 'close' | 'native'): Promise<RunResult> {
  const { browser, session } = await launch({ headless: P.headless, attachToWebPages: false });
  try {
    const cdp = await browser.target().createCDPSession();
    await openFixtureTabs(cdp, fixtures);
    await quietDashboard(session!.driver, session!.extensionId);
    const ids = await closableFixtureTabs(session!.driver, P.close);
    await waitUntil(async () => { const state = await session!.state(); return ids.length === P.close && ids.every(id => state.tabs[id]); }, 'the worker to track every tab');
    const before = await settledSample(cdp);
    if (how === 'close') {
      for (const tabId of ids) { const r = await session!.send({ type: 'DISCARD', tabId }); if (!r.success) throw new Error(`AdaptiveTab did not close tab ${tabId}: ${JSON.stringify(r)}`); }
    } else {
      for (const tabId of ids) await session!.ext(id => chrome.tabs.discard(id).then(() => undefined), tabId);
    }
    const after = await settledSample(cdp);
    const remaining = await fixtureTabs(session!.driver);
    const verified = how === 'close' ? remaining.length === P.tabs - P.close : remaining.filter(t => t.discarded).length === P.close;
    if (!verified) throw new Error(`${how}: expected ${P.close} tabs ${how === 'close' ? 'closed' : 'discarded'}, Chrome reports ${JSON.stringify(remaining.map(t => [t.title, t.discarded]))}`);
    return {
      condition: how === 'close' ? `AdaptiveTab Discard (closes ${P.close} tabs)` : `Chrome native discard of ${P.close} tabs`,
      beforeWorkingSetMiB: before.workingSetMiB, afterWorkingSetMiB: after.workingSetMiB, reclaimedWorkingSetMiB: before.workingSetMiB - after.workingSetMiB,
      beforePrivateMiB: before.privateMiB, afterPrivateMiB: after.privateMiB, reclaimedPrivateMiB: before.privateMiB === undefined ? undefined : before.privateMiB - after.privateMiB!,
      processesBefore: before.processes, processesAfter: after.processes,
    };
  } finally { await browser.close(); }
}

function summarize(runs: RunResult[]): RunResult[] {
  const byCondition = new Map<string, RunResult[]>();
  for (const run of runs) byCondition.set(run.condition, [...(byCondition.get(run.condition) ?? []), run]);
  return [...byCondition.entries()].map(([condition, rs]) => {
    const out: RunResult = { condition };
    for (const key of Object.keys(rs[0])) if (key !== 'condition' && typeof rs[0][key] === 'number') out[key] = median(rs.map(r => r[key] as number));
    return out;
  });
}

const executablePath = findBrowser();
if (!executablePath) throw new Error('No Chrome, Edge or Chromium found; set ADAPTIVETAB_BROWSER.');
const fixtures = await startFixtures();
const runs: RunResult[] = [];
let browserVersion = '';
try {
  for (let r = 1; r <= P.repeats; r++) {
    console.error(`repeat ${r}/${P.repeats}`);
    runs.push(await runBaseline(fixtures));
    runs.push(await runExtensionIdleAndScans(fixtures));
    runs.push(await runReclaim(fixtures, 'close'));
    runs.push(await runReclaim(fixtures, 'native'));
  }
  const { browser } = await launch({ extension: false, headless: P.headless });
  browserVersion = await browser.version(); await browser.close();
} finally { await fixtures.close(); }

const environment = { date: new Date().toISOString(), browser: `${browserVersion} (${executablePath})`, headless: P.headless, os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`, totalMemGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version };
const summary = summarize(runs);
mkdirSync(flags.out, { recursive: true });
const file = `${flags.out}/run-${environment.date.replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ environment, parameters: P, summary, runs }, null, 2));

const fmt = (v: unknown) => typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) : String(v ?? 'n/a');
console.log(`Environment: ${JSON.stringify(environment)}\nParameters: ${JSON.stringify(P)}\n`);
for (const row of summary) console.log(`| ${row.condition} | ${Object.entries(row).filter(([k]) => k !== 'condition').map(([k, v]) => `${k}=${fmt(v)}`).join(' | ')} |`);
console.log(`\nMedians over ${P.repeats} repeat(s); raw runs in ${file}`);
