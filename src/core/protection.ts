import type { TabMetadata } from './types';
export function protectionReason(tab: TabMetadata): string | undefined {
  if (tab.active) return 'Active tab';
  if (tab.pinned) return 'Pinned tab';
  if (tab.audible) return 'Playing audio';
  return undefined;
}
export function eligible(tab: TabMetadata): boolean { return !protectionReason(tab) && !tab.discarded && !tab.loading && !['DISCARDING','RESTORING'].includes(tab.lifecycle); }
