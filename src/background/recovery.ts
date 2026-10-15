import type { TabMetadata } from '../core/types';

/** Merge persisted history with the live Chrome tab inventory after a worker restart. */
export function reconcileTabs(
  saved: Record<number, TabMetadata>,
  observed: TabMetadata[],
  now = Date.now(),
): Record<number, TabMetadata> {
  const recovered: Record<number, TabMetadata> = {};
  for (const current of observed) {
    const previous = saved[current.id];
    const tab: TabMetadata = previous
      ? { ...previous, ...current, createdAt: previous.createdAt }
      : current;

    tab.lifecycle = current.discarded
      ? 'DISCARDED'
      : previous?.lifecycle === 'RESTORING' && current.loading
        ? 'RESTORING'
        : 'ACTIVE';
    if (previous && previous.lifecycle !== tab.lifecycle) tab.lifecycleAt = now;

    recovered[current.id] = tab;
  }
  return recovered;
}
