import { ClockPolicy, selectPolicy } from '../algorithms/policies';
import type { PolicyName, TabMetadata } from '../core/types';
import { evictionQuality } from './metrics';
export interface TraceResult { policy: PolicyName|'none'|'belady'|'fixed-timeout'; misses: number; hits: number; hitRate: number; evictions: number; victims: number[]; evaluatedEvictions:number; avoidableEvictions:number; avoidableEvictionRate?:number; evictionAccuracy?:number; }
export function replayTrace(trace: number[], capacity: number, policy: PolicyName|'none'|'belady'|'fixed-timeout', workingSetMs=5,futureReferenceHorizon=5): TraceResult {
  const resident=new Set<number>(), last=new Map<number,number>(), metas=new Map<number,TabMetadata>(); const replacement=policy==='clock'?new ClockPolicy():undefined; let misses=0; const victims:number[]=[];const samples:{victimId:number;referenceIndex:number}[]=[];
  for(let i=0;i<trace.length;i++) { const id=trace[i]; if(resident.has(id)){last.set(id,i);const t=metas.get(id);if(t)t.referenceBit=true;continue;} misses++;
    if(capacity<=0)continue;
    if(resident.size>=capacity && policy!=='none') {
      let victim:number|undefined;
      if(policy==='belady') victim=[...resident].sort((a,b)=>{const an=nextIndex(trace,a,i),bn=nextIndex(trace,b,i);return an===bn?a-b:bn-an;})[0];
      else if(policy==='fixed-timeout') { const aged=[...resident].filter(x=>i-(last.get(x)??0)>workingSetMs).sort((a,b)=>(last.get(a)??0)-(last.get(b)??0)||a-b); victim=aged[0]??[...resident].sort((a,b)=>(last.get(a)??0)-(last.get(b)??0)||a-b)[0]; }
      else { const candidates=[...resident].map(x=>metas.get(x)!); const chosen=(replacement??selectPolicy(policy)).selectVictim(candidates,candidates,{now:i,workingSetMs}); for(const cleared of chosen.clearedReferenceBits??[]){const t=metas.get(cleared);if(t)t.referenceBit=false;} chosen.commit?.(); victim=chosen.tab?.id; }
      if(victim!==undefined){resident.delete(victim);victims.push(victim);samples.push({victimId:victim,referenceIndex:i});metas.delete(victim);}
    }
    resident.add(id);last.set(id,i);metas.set(id,{id,url:'',title:'',windowId:0,createdAt:0,lastActiveAt:i,accessCount:1,focusDurationMs:0,pinned:false,audible:false,active:false,loading:false,discarded:false,lifecycle:'ACTIVE',lifecycleAt:0,version:0,referenceBit:true,queue:0,lastQueueChangeAt:0});
  }
  const hits=trace.length-misses; return {policy,misses,hits,hitRate:trace.length?hits/trace.length:0,evictions:victims.length,victims,...evictionQuality(trace,samples,futureReferenceHorizon)};
}
function nextIndex(trace:number[],id:number,i:number):number { const n=trace.indexOf(id,i+1);return n<0?Infinity:n; }
export function sampleTraces(): Record<string,number[]> { return { sequential:[1,2,3,4,5,1,2,3,4,5], locality:[1,2,1,3,1,2,4,1,2,3,1,2], randomAccess:[1,4,2,5,3,1,6,2,5,4,3,6], workingSet:Array.from({length:24},(_,i)=>[1,2,3,4][i%4]).concat([5,6,7,8,1,2,3,4])}; }
export function syntheticTrace(tabCount:number,length:number,seed=1):number[]{let value=seed>>>0;const next=()=>{value=(1664525*value+1013904223)>>>0;return value;};return Array.from({length},()=>1+next()%Math.max(1,tabCount));}
