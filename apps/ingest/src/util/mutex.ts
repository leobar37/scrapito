/**
 * A minimal FIFO async mutex. Used to serialize switch-plus-operation sequences
 * against a single agent-browser session, whose active tab is global.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively; queued callers execute in FIFO order. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.tail = promise;
    await previous;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

/** A registry of per-key mutexes (e.g. one per session name). */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock.runExclusive(fn);
  }
}
