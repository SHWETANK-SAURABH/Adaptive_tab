import { replayTrace, sampleTraces, syntheticTrace } from '../src/evaluation/trace-replay';

function printResult(policy: string, result: ReturnType<typeof replayTrace>) {
  const accuracy = result.evictionAccuracy === undefined ? 'n/a' : `${(result.evictionAccuracy * 100).toFixed(1)}%`;
  const avoidable = result.avoidableEvictionRate === undefined ? 'n/a' : `${(result.avoidableEvictionRate * 100).toFixed(1)}%`;
  console.log(`${policy.padEnd(14)} hit ${(result.hitRate * 100).toFixed(1)}% | misses ${result.misses} | evictions ${result.evictions} | accuracy ${accuracy} | avoidable ${avoidable}`);
}

for (const [name, trace] of Object.entries(sampleTraces())) {
  console.log(`\n${name} (${trace.length} references, capacity 3, future horizon 5)`);
  for (const policy of ['lru', 'working-set', 'clock', 'fixed-timeout', 'belady', 'none'] as const) {
    printResult(policy === 'none' ? 'no-management' : policy, replayTrace(trace, 3, policy, 5, 5));
  }
}
for (const tabCount of [10, 25, 50]) {
  const trace = syntheticTrace(tabCount, tabCount * 8, 2026);
  const capacity = Math.floor(tabCount / 3);
  console.log(`\nseeded random (${tabCount} tabs, ${trace.length} references, capacity ${capacity}, future horizon 15)`);
  for (const policy of ['lru', 'working-set', 'clock', 'fixed-timeout', 'belady'] as const) {
    printResult(policy, replayTrace(trace, capacity, policy, 15, 15));
  }
}
