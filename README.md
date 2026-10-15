# AdaptiveTab

AdaptiveTab is a local-first Chrome Manifest V3 extension project applying page-replacement and scheduling ideas to browser tabs. The extension is intentionally opt-in: it begins in manual, dry-run mode.

## Prerequisites and install

- Node.js 20 or newer and npm.
- Google Chrome with developer mode enabled.

Run `npm install`, then `npm run build`. In Chrome open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this repository's `dist` directory. The popup shows live extension state. Open `index.html` through Vite for UI development; browser APIs are only available in the installed extension.

## Development and verification

- `npm run dev` — Vite development server.
- `npm test` — policy and lifecycle unit tests.
- `npm run evaluate` — deterministic synthetic trace comparison.
- `npm run build` — TypeScript check and production extension bundle.
- `npm run test:e2e` — builds, then runs the real-browser suite in `e2e/` against `dist/` in a locally installed Chrome, Edge or Chromium (set `ADAPTIVETAB_BROWSER` to choose one, `HEADED=1` to watch). It covers real tab events, closing and reopening tabs, service-worker termination and restart, recovery of interrupted operations, multiple windows, Chrome's own discards, and the scan alarm. The suite is skipped if no browser is found.
- `npm run measure` — builds, then runs the memory and CPU experiment described in [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md); raw results go to `measurements/`.

## Architecture and OS mapping

- `src/algorithms/policies.ts`: LRU chooses the oldest activation, Working Set prefers pages untouched beyond a time window with an LRU fallback, and Clock clears recent-reference bits for a second chance. Selection is O(n); metadata-backed LRU updates are O(1), though this small browser-tab pool uses an O(n) selection pass.
- `src/scheduler/mlfq.ts`: an MLFQ-inspired four-queue classification based on activity and configured idle thresholds. It is kept separate from replacement selection.
- `src/core/lifecycle.ts`: validates lifecycle transitions with per-tab version increments.
- `src/background/service-worker.ts`: observes Chrome tab events, recovers once before processing work, persists state in `chrome.storage.local`, uses alarms, and closes the selected tab with `chrome.tabs.remove` after rechecking browser state, keeping its URL and position so it can be reopened. `src/background/tab-operation-coordinator.ts` coalesces duplicate operations per tab while keeping other tabs independent.
- `src/ui`: React dashboard/popup with live inventory, policy selection, queue view, analytics, settings, activity export, and manual actions.
- `src/evaluation`: browser-independent deterministic trace replay and latency percentile helpers.

## Safety and limitations

Discard closes the tab. Before closing, the extension records its URL, title, window and position; the latest 100 closed tabs are listed under **Closed by AdaptiveTab** in Tab Manager with a **Reopen** button. Reopening loads the URL in a new tab, so back/forward history, scroll position and unsaved form input are lost. Active, pinned, audible, loading, already discarded, and in-flight tabs are excluded from candidate selection. Chrome exposes no dependable extension signal for arbitrary unsaved form data, upload state per tab, or per-tab RAM, so those states cannot be guaranteed protected or measured. Memory indicators therefore show tab counts only. Tabs that Chrome itself has discarded (for example by Memory Saver) still show **Restore**, which activates them. A restore timestamp endpoint is available from reopen or activation to page-load completion, but population-level latency aggregation is not yet implemented.

Automatic mode is off and dry run is on initially. A preview/manual discard is a user action. For automatic closing, enable automatic mode and explicitly turn off dry run in Settings. If Chrome refuses to close a tab, it returns to `ACTIVE` and the dashboard shows the reason.

The MV3 worker reconstructs tracked tabs from Chrome and persisted metadata after startup. Per-tab mutexes serialize requests within a worker instance; Chrome's actual tab state plus persisted transitional status handles restarts. This is not a cross-process distributed lock. When Chrome discards a tab it replaces it with a new tab id (`tabs.onReplaced`); the worker moves the tab's record and history to the new id.

## Evaluation methodology

`npm run evaluate` replays identical access sequences with a fixed resident capacity, plus seeded random traces at 10, 25, and 50 tabs. Cache hit rate is hits / references; misses count first loads and refaults. Evictions count resident replacement operations. Belady uses future knowledge and is a theoretical lower-miss bound for the same capacity. The fixed-timeout baseline prefers pages beyond its inactivity window and falls back to LRU when the resident budget is full; `none` never evicts and can exceed capacity, so it is a separate no-management reference. These simulations measure policy behavior, never physical RAM savings. Physical memory and CPU are measured separately in a live browser; see [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

The extension records scan duration and activation-to-load-complete restoration latency, retaining the latest 500 samples of each. Their summaries describe only recorded extension events, not subjective website readiness. The trace evaluator reports simulated eviction accuracy using its displayed future-reference horizon. System memory and CPU are measured in a live browser by `npm run measure` ([docs/MEASUREMENTS.md](docs/MEASUREMENTS.md)). In the documented run (Chrome 155, Windows, 12 tabs of 40 MiB), closing 6 tabs with AdaptiveTab freed 551 MiB of working set (362 MiB private) right away. Chrome's native discard of the same tabs freed about 17 MiB private within the measurement window, because the discarded tabs' renderer processes stayed alive. With its worker running, the extension added about 36 MiB and 0.8 ms of CPU per second. Those figures come from synthetic pages on one machine; see the document for the method and limitations. Simulated trace results must not be presented as RAM saved. Still unmeasured: behaviour under real memory pressure, real-world sites, and other operating systems and browser versions.

## Privacy

Tab titles, URLs and operational metadata remain in local Chrome extension storage. There is no backend, account, analytics service, or external API.
