/**
 * Sliding-window token bucket: at most `capacity` takes in any `windowMs` span.
 * The clock is injected so tests never need real time.
 */
export class TokenBucket {
  capacity: number;
  windowMs: number;
  now: () => number;
  takes: number[];

  constructor(capacity: number, windowMs: number, now: () => number) {
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.now = now;
    this.takes = [];
  }

  #prune(t: number): void {
    const cutoff = t - this.windowMs;
    // A take at time x is inside the window while x > now - windowMs.
    let i = 0;
    while (i < this.takes.length && this.takes[i] <= cutoff) i++;
    if (i > 0) this.takes.splice(0, i);
  }

  tryTake(): boolean {
    const t = this.now();
    this.#prune(t);
    if (this.takes.length >= this.capacity) return false;
    this.takes.push(t);
    return true;
  }

  /** Milliseconds until a take would succeed; 0 when one is available now. */
  msUntilNext(): number {
    const t = this.now();
    this.#prune(t);
    if (this.takes.length < this.capacity) return 0;
    const oldest = this.takes[0];
    return Math.max(0, oldest + this.windowMs - t);
  }
}
