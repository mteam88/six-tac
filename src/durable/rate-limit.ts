type Bucket = {
  count: number;
  windowStartedAt: number;
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt = 0;

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    this.sweep(now, windowMs);

    const existing = this.buckets.get(key);
    if (!existing || now - existing.windowStartedAt >= windowMs) {
      this.buckets.set(key, {
        count: 1,
        windowStartedAt: now,
      });
      return true;
    }

    if (existing.count >= limit) {
      return false;
    }

    existing.count += 1;
    return true;
  }

  private sweep(now: number, maxAgeMs: number): void {
    if (now - this.lastSweepAt < maxAgeMs) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= maxAgeMs) {
        this.buckets.delete(key);
      }
    }

    this.lastSweepAt = now;
  }
}

export function rateLimitKey(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part ?? "").join(":");
}
