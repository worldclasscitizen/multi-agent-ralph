export class ConnectionLimits {
  private active = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  constructor(readonly limit = 1) {}
  async use<T>(
    key: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    while ((this.active.get(key) ?? 0) >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.waiters.set(
            key,
            (this.waiters.get(key) ?? []).filter((x) => x !== wake),
          );
          reject(signal.reason);
        };
        if (signal.aborted) return reject(signal.reason);
        this.waiters.set(key, [...(this.waiters.get(key) ?? []), wake]);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    signal.throwIfAborted();
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.active.set(key, this.active.get(key)! - 1);
      this.waiters.get(key)?.shift()?.();
    }
  }
}
