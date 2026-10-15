import { TRANSITIONS, type Lifecycle, type TabMetadata } from './types';
export function transition(tab: TabMetadata, next: Lifecycle, now = Date.now()): TabMetadata {
  if (tab.lifecycle === next) return tab;
  if (!TRANSITIONS[tab.lifecycle].includes(next)) throw new Error(`Invalid tab transition ${tab.lifecycle} -> ${next}`);
  return { ...tab, lifecycle: next, lifecycleAt: now, version: tab.version + 1 };
}
