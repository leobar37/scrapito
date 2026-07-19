export class ConcurrencyGate {
  #active = 0;
  #maxObserved = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("gate limit must be a positive integer");
  }

  get maxObserved(): number {
    return this.#maxObserved;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.limit) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.#waiters.push(() => {
          this.#active += 1;
          resolve();
        });
      });
    }
    this.#maxObserved = Math.max(this.#maxObserved, this.#active);
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiters.shift()?.();
    }
  }
}

export class WriteGate extends ConcurrencyGate {
  constructor() {
    super(1);
  }
}
