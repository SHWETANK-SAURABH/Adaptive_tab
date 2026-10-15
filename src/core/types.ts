export type PolicyName = 'lru' | 'working-set' | 'clock';
export type Lifecycle = 'ACTIVE' | 'CANDIDATE' | 'DISCARDING' | 'DISCARDED' | 'RESTORING';
export type QueueLevel = 0 | 1 | 2 | 3;
export interface TabMetadata {
  id: number; url: string; title: string; windowId: number; createdAt: number; lastActiveAt: number;
  accessCount: number; focusDurationMs: number; pinned: boolean; audible: boolean; active: boolean;
  loading: boolean; discarded: boolean; lifecycle: Lifecycle; lifecycleAt: number; version: number;
  referenceBit: boolean; queue: QueueLevel; lastQueueChangeAt: number; protectionReason?: string;
  restorationStartedAt?: number;
}
/** A tab closed by Discard, kept so it can be reopened at its old position. */
export interface ClosedTab {
  key: string; id: number; url: string; title: string; windowId: number; index: number;
  closedAt: number; lastActiveAt: number; accessCount: number;
}
export interface Settings {
  policy: PolicyName; tabBudget: number; workingSetMs: number; scanMinutes: number;
  automatic: boolean; dryRun: boolean; batchSize: number; queueDemotionMs: number[]; boostMinutes: number;
}
export interface RuntimeMetrics {
  scanDurationsMs: number[];
  restorationLatenciesMs: number[];
}
export const DEFAULT_RUNTIME_METRICS: RuntimeMetrics = { scanDurationsMs: [], restorationLatenciesMs: [] };
export const DEFAULT_SETTINGS: Settings = { policy: 'lru', tabBudget: 20, workingSetMs: 300_000, scanMinutes: 5, automatic: false, dryRun: true, batchSize: 2, queueDemotionMs: [0, 300_000, 900_000, 1_800_000], boostMinutes: 30 };
export interface Decision { victimId?: number; reason: string; policy: PolicyName; at: number; }
export interface ActivityEvent { id: string; at: number; type: string; message: string; tabId?: number; }
export const TRANSITIONS: Record<Lifecycle, Lifecycle[]> = {
  ACTIVE: ['CANDIDATE','DISCARDED','RESTORING'], CANDIDATE: ['ACTIVE','DISCARDING','DISCARDED'],
  DISCARDING: ['ACTIVE','DISCARDED'], DISCARDED: ['RESTORING','ACTIVE'], RESTORING: ['ACTIVE','DISCARDED']
};
