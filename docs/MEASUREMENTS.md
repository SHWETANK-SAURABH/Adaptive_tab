# Memory and CPU measurements

This is the live-browser experiment behind AdaptiveTab's memory and CPU claims. The trace evaluator (`npm run evaluate`) only simulates policy behavior. This experiment measures what the operating system reports for a real browser running the built extension.

## How to run it

```sh
npm run measure                       # defaults below; about 6 minutes
npm run measure -- --tabs 20 --mb 60 --close 10 --repeats 5 --headed
```

The script is `scripts/measure.ts`. It uses the same harness as the e2e suite (`e2e/harness.ts`) and drives the first Chrome, Edge or Chromium it finds; set `ADAPTIVETAB_BROWSER` to choose one. It prints a summary table and writes every run to `measurements/run-<timestamp>.json`. That folder is git-ignored.

| Flag | Default | Meaning |
|---|---|---|
| `--tabs` | 12 | Fixture tabs opened in each run |
| `--mb` | 40 | Memory each fixture page allocates and touches |
| `--close` | 6 | Tabs closed or discarded in the reclaim runs |
| `--repeats` | 3 | Repeats of every condition; the table reports medians |
| `--settle` | 5 | Seconds to wait before each memory reading |
| `--idle` | 10 | Idle window for the idle CPU reading, in seconds |
| `--scans` | 20 | Manual scans timed in the scan-cost reading |

## Method

**Workload.** A local HTTP server serves fixture pages. Each page allocates `--mb` MiB in 1 MiB typed arrays and writes to every 4 KiB page so the memory is committed, not just reserved. Each fixture is served from its own site (`t<n>.localhost`), so Chrome gives every tab its own renderer process, as it would for unrelated real sites. Tabs open in the background through the DevTools protocol, and Puppeteer never attaches to them, so no automation session adds memory to a measured tab. A page reports back to the server once its allocation is finished, and the script waits for that before measuring.

**Memory.** The script takes Chrome's own process list for the browser instance (`SystemInfo.getProcessInfo`: browser, renderers, GPU and utility processes). It asks the OS for each process's memory and sums the results. On Windows it records the working set (resident memory) and private bytes (memory committed to that process alone). On Linux and macOS it records RSS. Each reading is the median of three samples taken one second apart, after `--settle` seconds.

**CPU.** The script sums the cumulative CPU time Chrome reports for every process in the same list. Idle CPU is the increase over `--idle` seconds with nothing happening. Scan cost is the increase while running `--scans` manual scans back to back, minus the idle rate for the same duration, divided by the number of scans.

**Conditions.** Each condition runs in a fresh browser with a fresh profile:

1. **Baseline:** fixture tabs, no extension.
2. **Extension loaded:** the same tabs with `dist/` installed and the service worker running. The dashboard tab is switched to `about:blank` while measuring, so both runs have the same tabs. After that, the script measures the cost of `--scans` scans.
3. **AdaptiveTab Discard:** sends AdaptiveTab's `DISCARD` message for `--close` background fixture tabs. This is the dashboard's Discard action, which closes the tab. The script checks that Chrome no longer lists those tabs.
4. **Chrome native discard:** calls `chrome.tabs.discard` on the same number of tabs. This is the mechanism Chrome's Memory Saver uses. The script checks that Chrome reports those tabs as discarded.

## Results

Run on 2026-10-16 with the default parameters (12 tabs of 40 MiB, 6 closed or discarded, 3 repeats). Values are medians of the three repeats.

- **Browser:** Chrome 155.0.8059.79, headless
- **System:** Windows 11 (10.0.26300), AMD Ryzen 7 7435HS (16 threads), 23.7 GiB RAM
- **Runtime:** Node 24.7.0

| Condition | Working set (MiB) | Private (MiB) | Processes | Idle CPU (ms per s) |
|---|---:|---:|---:|---:|
| Baseline, no extension | 1550 | 939 | 19 | 3.6 |
| Extension loaded, worker running | 1586 | 954 | 19 | 4.4 |
| **Extension overhead** | **+36** | **+15** | | **+0.8** |

| Reclaim action (6 of 12 tabs) | Before (MiB) | After (MiB) | Freed working set | Freed private | Processes |
|---|---:|---:|---:|---:|---:|
| AdaptiveTab Discard (closes tabs) | 1596 | 1045 | **551 MiB** (about 92 per tab) | **362 MiB** (about 60 per tab) | 19 → 13 |
| Chrome native discard | 1598 | 1599 | about 0 MiB | 17 MiB | 19 → 19 |

| Scan cost | Value |
|---|---|
| Browser-wide CPU per manual scan | 25 ms |
| Scan time inside the worker (p50 / max) | 1.1 ms / 1.9 ms |

The three repeats agreed closely. Freed working set was 554, 545 and 551 MiB for closing, and −14, −3 and +2 MiB for native discard.

## What the numbers mean

- **Closing tabs frees the memory immediately.** Each closed tab ends its renderer process. That frees the page's own memory (40 MiB here) plus about 50 MiB of per-process working set, of which roughly 20 MiB is private.
- **Native discard freed almost nothing within the measurement window.** Chrome marked the tabs as discarded, but their renderer processes stayed alive. A separate check kept watching for 60 seconds, with no DevTools session attached to the tabs, and the processes still did not exit. Closing tabs in the same setup ended their processes within 2 seconds. Chrome may release this memory later, or only under real memory pressure. This experiment does not show that it never does; it shows only that a discard does not give memory back promptly here.
- **The extension's idle cost is small.** With the worker running it added about 36 MiB working set (15 MiB private) and 0.8 ms of CPU per second, which is about 0.08% of one core. Chrome stops an idle MV3 worker after about 30 seconds, after which its process can exit, so this is closer to a worst case than a typical figure.
- **A scan is cheap.** Inside the worker a scan takes about 1 ms. The 25 ms of browser-wide CPU per scan is an upper bound: it includes the dashboard page sending each message and the DevTools round trip that drives it.

## Limitations

- Only one machine, one OS and one browser version were measured. Headless mode has no visible GPU compositing, so absolute numbers in a normal headed profile will be higher. The differences between conditions are the meaningful part.
- The fixture pages are synthetic: a fixed allocation with no network activity, timers, media or workers. Real sites use more memory per process and do background work that closing a tab also stops.
- Native discard was measured without memory pressure. Memory Saver normally discards tabs when the system is under pressure, and Chrome may reclaim memory differently then.
- Closing a tab also loses its back/forward history, scroll position and form input; reopening reloads the URL. Native discard keeps the tab in the tab strip. The memory numbers do not capture that difference in user experience.
- Working set includes shared pages, such as Chrome's own code, that are counted in every process. That is why the drop in private bytes is smaller than the drop in working set.
