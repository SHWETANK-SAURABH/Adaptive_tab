export type TabOperationKind = 'discard' | 'restore';

export class TabBusyError extends Error {
  constructor(readonly tabId: number, readonly activeOperation: TabOperationKind) {
    super(`Tab ${tabId} already has a ${activeOperation} operation in progress`);
    this.name = 'TabBusyError';
  }
}

interface Operation<T = unknown> {
  kind: TabOperationKind;
  promise: Promise<T>;
}

/** Serializes operations per tab while allowing unrelated tabs to proceed independently. */
export class TabOperationCoordinator {
  private readonly active = new Map<number, Operation>();

  run<T>(tabId: number, kind: TabOperationKind, task: () => Promise<T>): Promise<T> {
    const existing = this.active.get(tabId);
    if (existing) {
      if (existing.kind === kind) return existing.promise as Promise<T>;
      return Promise.reject(new TabBusyError(tabId, existing.kind));
    }

    const operation: Operation<T> = { kind, promise: Promise.resolve().then(task) };
    this.active.set(tabId, operation);
    return operation.promise.finally(() => {
      if (this.active.get(tabId) === operation) this.active.delete(tabId);
    });
  }

  isBusy(tabId: number): boolean {
    return this.active.has(tabId);
  }
}
