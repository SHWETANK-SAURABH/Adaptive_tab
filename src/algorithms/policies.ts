import type { PolicyName, TabMetadata } from '../core/types';
export interface PolicyConfig { now: number; workingSetMs: number; }
export interface Selection {
  tab?: TabMetadata; reason: string;
  /** Tabs whose reference bit the policy cleared while choosing. Policies never mutate their inputs; callers apply this only when they act on the selection. */
  clearedReferenceBits?: number[];
  /** Advances the policy's own state (the Clock hand). Call only when the selection is acted on. */
  commit?: () => void;
}
export interface Policy {
  selectVictim(candidates: TabMetadata[], state: TabMetadata[], config: PolicyConfig): Selection;
  /** A copy with the same internal state, for previews that must not move the real policy. Stateless policies omit it. */
  fork?(): Policy;
}
const stable = (a: TabMetadata,b: TabMetadata) => a.id-b.id;
export const lru: Policy = { selectVictim(c, _s, _cfg) { const tab = [...c].sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b))[0]; return { tab, reason: tab ? `Least recently active (${new Date(tab.lastActiveAt).toISOString()})` : 'No eligible tabs' }; } };
export const workingSet: Policy = { selectVictim(c,_s,cfg) { const aged=[...c].filter(t=>cfg.now-t.lastActiveAt>cfg.workingSetMs).sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b)); const tab=aged[0]??[...c].sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b))[0]; return {tab,reason:tab?(aged.length?'Outside working-set window':'All candidates are in the working set; evicting LRU fallback'):'No eligible tabs'}; } };
export class ClockPolicy implements Policy {
  /** Id of the tab the hand last selected; the next sweep starts at the first tab id after it. Ids stay meaningful as tabs open and close. */
  private handId?: number;
  selectVictim(c: TabMetadata[], _s: TabMetadata[], _cfg: PolicyConfig): Selection {
    if (!c.length) return { reason: 'No eligible tabs' };
    const ordered=[...c].sort(stable); const after=this.handId===undefined?0:ordered.findIndex(t=>t.id>this.handId!); const start=after<0?0:after; const cleared:number[]=[];
    for(let k=0;k<ordered.length;k++) { const tab=ordered[(start+k)%ordered.length]; if(!tab.referenceBit)return this.chosen(tab,cleared,'Clock hand selected a tab with a clear reference bit'); cleared.push(tab.id); }
    // Every bit was set: a full sweep clears them all and the hand comes back to where it started.
    return this.chosen(ordered[start],cleared,'Clock second-chance scan cleared all reference bits');
  }
  fork(): ClockPolicy { const copy=new ClockPolicy(); copy.handId=this.handId; return copy; }
  private chosen(tab: TabMetadata, cleared: number[], reason: string): Selection { return { tab, reason, clearedReferenceBits: cleared, commit: () => { this.handId = tab.id; } }; }
}
export const clock = new ClockPolicy();
export function selectPolicy(name: PolicyName): Policy { return name==='lru'?lru:name==='working-set'?workingSet:clock; }
