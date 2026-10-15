# Next Stage Plan: Concurrency and Recovery

## Why this is next

Tab monitoring, replacement policies, and the dashboard are already present. The most failure-prone path is now the Manifest V3 event and discard workflow: tab events, popup messages, alarms, and worker restarts can overlap while state is persisted.

## Stage goal

Make per-tab operations idempotent within a service-worker lifetime and make startup recovery a single, explicit prerequisite for handling work. Preserve Chrome's live tab state as the authority and keep interrupted operations recoverable from persisted lifecycle state.

## Work items

1. Add a per-tab operation coordinator. Repeated requests for the same operation share one in-flight result; conflicting operations on one tab fail clearly; unrelated tabs remain independent.
2. Integrate it into the discard workflow and persist the `DISCARDING` state before calling Chrome.
3. Replace repeated message-time full recovery with one worker readiness promise. Startup and install recovery reconcile persisted records with current Chrome tabs before messages and alarms mutate state.
4. Add deterministic tests for duplicate requests, conflicting requests, failure cleanup, persisted `DISCARDING` recovery, closed tabs, and observed browser state taking precedence.
5. Run the test suite, trace evaluator, and production build; document remaining browser-only checks.

## Acceptance criteria

- A duplicate discard request for a tab triggers only one browser API operation and receives the same result.
- A different operation cannot race a discard on the same tab; operations on different tabs can proceed concurrently.
- Recovery converts interrupted `DISCARDING` records to `DISCARDED` when Chrome reports discarded, otherwise to `ACTIVE`.
- Closed tabs are removed during recovery, and every current Chrome tab appears in the recovered snapshot.
- The worker does not repeatedly overwrite event updates with stale storage snapshots on every UI message.
- Unit tests and the production build pass.

## Progress

- [x] Per-tab operation coordinator with duplicate coalescing and conflict rejection.
- [x] Discard and restore message paths use the coordinator.
- [x] Single readiness recovery is used instead of reloading storage on every message.
- [x] Recovery reconciles live tabs, removes closed tabs, and resolves interrupted lifecycle states.
- [x] Unit coverage for duplicate/conflicting operations, failure cleanup, and restart reconciliation.
- [x] Unit tests and production build pass.
- [ ] Browser-backed tests for real Chrome event ordering and service-worker termination.

## Follow-on stage

The measurement follow-on is implemented below. Mocked service-worker integration coverage now exercises tab inventory, settings persistence, scanning, discard, restore, and recovery. Real Chrome event ordering and service-worker termination still need browser-backed checks. System memory and CPU comparisons also require controlled browser and operating-system experiments; synthetic traces remain simulations.

## Measurement follow-on progress

- [x] Record activation-to-load-complete restoration latency and retain the latest 500 observations.
- [x] Measure scan duration, including tab synchronization and candidate selection.
- [x] Calculate simulated avoidable-eviction rate and eviction accuracy using an explicit future-reference horizon.
- [x] Surface live latency and scan timing summaries in Analytics and label the endpoint.
- [x] Add mocked service-worker integration coverage for tab operations, settings persistence, and recovery.
- [ ] Verify real Chrome event ordering and service-worker termination in a browser-backed run.
- [ ] Measure system memory and CPU overhead in a documented real-browser experiment.
