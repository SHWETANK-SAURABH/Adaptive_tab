import type { PolicyName, TabMetadata } from '../core/types';
export interface PolicyConfig { now: number; workingSetMs: number; }
export interface Policy { selectVictim(candidates: TabMetadata[], state: TabMetadata[], config: PolicyConfig): { tab?: TabMetadata; reason: string }; }
const stable = (a: TabMetadata,b: TabMetadata) => a.id-b.id;
export const lru: Policy = { selectVictim(c, _s, _cfg) { const tab = [...c].sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b))[0]; return { tab, reason: tab ? `Least recently active (${new Date(tab.lastActiveAt).toISOString()})` : 'No eligible tabs' }; } };
export const workingSet: Policy = { selectVictim(c,_s,cfg) { const aged=[...c].filter(t=>cfg.now-t.lastActiveAt>cfg.workingSetMs).sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b)); const tab=aged[0]??[...c].sort((a,b)=>a.lastActiveAt-b.lastActiveAt||stable(a,b))[0]; return {tab,reason:tab?(aged.length?'Outside working-set window':'All candidates are in the working set; evicting LRU fallback'):'No eligible tabs'}; } };
export class ClockPolicy implements Policy {
  private hand = 0;
  selectVictim(c: TabMetadata[], _s: TabMetadata[], _cfg: PolicyConfig) {
    if (!c.length) return { reason: 'No eligible tabs' };
    const ordered=[...c].sort(stable); this.hand%=ordered.length;
    for(let scanned=0;scanned<ordered.length*2;scanned++) { const tab=ordered[this.hand]; this.hand=(this.hand+1)%ordered.length; if(!tab.referenceBit)return {tab,reason:'Clock hand selected a tab with a clear reference bit'}; tab.referenceBit=false; }
    return {tab:ordered[(this.hand+ordered.length-1)%ordered.length],reason:'Clock second-chance scan cleared all reference bits'};
  }
}
export const clock = new ClockPolicy();
export function selectPolicy(name: PolicyName): Policy { return name==='lru'?lru:name==='working-set'?workingSet:clock; }
