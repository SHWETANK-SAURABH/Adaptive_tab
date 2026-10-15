/// <reference types="node" />
// Shared real-browser harness for the e2e suite and the measurement script: finds a local
// Chromium-based browser, serves fixture pages, and launches the browser with dist/ loaded.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page, type Target } from 'puppeteer-core';

export const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/** The browser to drive: ADAPTIVETAB_BROWSER if set, otherwise the first installed Chrome, Edge or Chromium. */
export function findBrowser(): string | undefined {
  const fromEnv = process.env.ADAPTIVETAB_BROWSER;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  return (CANDIDATES[process.platform] ?? []).find(path => existsSync(path));
}

export async function waitUntil<T>(check: () => Promise<T> | T, what: string, timeoutMs = 15_000, intervalMs = 100): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try { const value = await check(); if (value) return value as NonNullable<T>; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export interface Fixtures {
  /** A page titled `Fixture <id>`. `mb` allocates and touches that much memory; `ownSite` serves it from its own site (t<id>.localhost) so it gets its own renderer process. */
  url(id: number | string, options?: { mb?: number; ownSite?: boolean }): string;
  /** True once the page with this id has finished allocating its memory (it reports back to the server). */
  loaded(id: number | string): boolean;
  /** Forgets which pages have loaded, so a new browser run can reuse ids. */
  reset(): void;
  close(): Promise<void>;
}

/** Serves fixture pages on a loopback port. */
export async function startFixtures(): Promise<Fixtures> {
  const loaded = new Set<string>();
  const server = createServer((request, response) => {
    const { pathname, searchParams: query } = new URL(request.url ?? '/', 'http://fixture');
    const id = (query.get('id') ?? '0').replace(/[^\w-]/g, '');
    if (pathname === '/loaded') { loaded.add(id); response.writeHead(204).end(); return; }
    const mb = Math.max(0, Math.min(512, Number(query.get('mb')) || 0));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>Fixture ${id}</title><p>Fixture ${id}</p><script>
      // Allocate and touch every 4 KiB page so the memory is actually committed, then keep it reachable.
      const blocks = [];
      for (let i = 0; i < ${mb}; i++) { const block = new Uint8Array(1 << 20); for (let j = 0; j < block.length; j += 4096) block[j] = 1; blocks.push(block); }
      window.__fixtureMemory = blocks;
      fetch('/loaded?id=${id}');
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (id, { mb = 0, ownSite = false } = {}) => `http://${ownSite ? `t${id}.localhost` : '127.0.0.1'}:${port}/page?id=${id}&mb=${mb}`,
    loaded: id => loaded.has(String(id)),
    reset: () => loaded.clear(),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const isWorker = (target: Target) => target.type() === 'service_worker' && target.url().endsWith('/service-worker.js');

export interface Session {
  browser: Browser;
  extensionId: string;
  /** The dashboard page (index.html) with its 3 s polling stopped, used to call extension APIs. */
  driver: Page;
  /** Sends a message to the background worker, waking it if Chrome stopped it. */
  send<T = any>(message: object): Promise<T>;
  state(): Promise<any>;
  /** Runs a function in the driver page, where `chrome.*` extension APIs are available. */
  ext<T, A extends unknown[]>(fn: (...args: A) => T | Promise<T>, ...args: A): Promise<Awaited<T>>;
  /** Opens a background tab and waits for it to finish loading; returns its id. */
  openTab(url: string, options?: { active?: boolean; windowId?: number }): Promise<number>;
  workerRunning(): boolean;
  workerTimeOrigin(): Promise<number>;
  /** Stops the extension's service worker, as Chrome does when it is idle, and waits until it is gone. */
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launches the browser, with dist/ loaded unless `extension` is false. With `attachToWebPages: false`, Puppeteer
 * never attaches DevTools to http(s) pages, so measurements of those tabs carry no automation overhead.
 */
export async function launch({ extension = true, headless = process.env.HEADED !== '1', attachToWebPages = true }: { extension?: boolean; headless?: boolean; attachToWebPages?: boolean } = {}): Promise<{ browser: Browser; session?: Session }> {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('No Chrome, Edge or Chromium found; set ADAPTIVETAB_BROWSER to a browser executable.');
  const browser = await puppeteer.launch({
    executablePath, headless, pipe: true,
    enableExtensions: extension ? [DIST] : false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
    ...(attachToWebPages ? {} : { targetFilter: (target: Target) => !/^https?:\/\//.test(target.url()) }),
  });
  if (!extension) return { browser };

  const workerTarget = await browser.waitForTarget(isWorker, { timeout: 15_000 });
  const extensionId = new URL(workerTarget.url()).host;
  const [driver = await browser.newPage()] = await browser.pages();
  await driver.goto(`chrome-extension://${extensionId}/index.html`);
  // Stop the dashboard's 3 s GET_STATE polling so it cannot wake a deliberately stopped worker.
  await driver.evaluate(() => { const last = setInterval(() => {}, 1e9) as unknown as number; for (let id = 0; id <= last; id++) clearInterval(id); });

  const ext: Session['ext'] = (fn, ...args) => driver.evaluate(fn as any, ...args) as any;
  const send: Session['send'] = message => ext(m => chrome.runtime.sendMessage(m), message);
  const session: Session = {
    browser, extensionId, driver, send, ext,
    state: async () => (await send({ type: 'GET_STATE' })).state,
    async openTab(url, { active = false, windowId } = {}) {
      const id = await ext((u, a, w) => chrome.tabs.create({ url: u, active: a, windowId: w }).then(t => t.id!), url, active, windowId);
      await waitUntil(() => ext(i => chrome.tabs.get(i).then(t => t.status === 'complete'), id), `tab ${id} to load`);
      return id;
    },
    workerRunning: () => browser.targets().some(isWorker),
    async workerTimeOrigin() {
      const target = await browser.waitForTarget(isWorker, { timeout: 15_000 });
      return (await target.worker())!.evaluate(() => performance.timeOrigin);
    },
    async stopWorker() {
      const target = await browser.waitForTarget(isWorker, { timeout: 15_000 });
      await (await target.worker())!.close();
      await waitUntil(() => !session.workerRunning(), 'the service worker to stop');
    },
    close: () => browser.close(),
  };
  return { browser, session };
}
