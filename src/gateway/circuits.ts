export class ProviderCircuits {
  private openUntil = new Map<string, number>();
  private probes = new Set<string>();
  restore(key: string, retryAt: number) {
    this.openUntil.set(key, retryAt);
  }
  available(key: string, now = Date.now()): boolean {
    return !this.probes.has(key) && (this.openUntil.get(key) ?? 0) <= now;
  }
  claim(key: string) {
    if (this.openUntil.has(key)) this.probes.add(key);
  }
  success(key: string) {
    this.openUntil.delete(key);
    this.probes.delete(key);
  }
  trip(key: string, delay = 60_000): number {
    const until = Date.now() + delay;
    this.openUntil.set(key, until);
    this.probes.delete(key);
    return until;
  }
}
