import type { QueueLevel, TabMetadata } from '../core/types';
export function promote(tab: TabMetadata, now=Date.now()): TabMetadata { return {...tab,queue:Math.max(0,tab.queue-1) as QueueLevel,lastQueueChangeAt:now}; }
export function demote(tab: TabMetadata, now=Date.now()): TabMetadata { return {...tab,queue:Math.min(3,tab.queue+1) as QueueLevel,lastQueueChangeAt:now}; }
export function updateQueue(tab: TabMetadata, now: number, thresholds: number[]): TabMetadata { if(tab.active)return tab.queue===0?tab:{...tab,queue:0,lastQueueChangeAt:now}; const next=Math.min(3,tab.queue+1) as QueueLevel; const waited=now-tab.lastQueueChangeAt; return next===tab.queue||waited<thresholds[next]?tab:{...tab,queue:next,lastQueueChangeAt:now}; }
export function globalBoost(tabs: TabMetadata[], now=Date.now()): TabMetadata[] { return tabs.map(t=>({...t,queue:0,lastQueueChangeAt:now})); }
