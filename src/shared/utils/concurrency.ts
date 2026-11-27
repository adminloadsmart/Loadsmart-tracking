/** `fn` over `items` with at most `limit` running at once; results keep the input order. A
 *  rejection is the caller's to catch inside `fn` — one escaping rejects the whole call. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/** Runs tasks one at a time, in call order (e.g. two loops that must never overlap). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Thrown when a Limiter's queue is full: the caller should back off and retry later. */
export class LimiterBusyError extends Error {
  constructor(name: string) {
    super(`${name} is busy`);
    this.name = 'LimiterBusyError';
  }
}

/** At most `concurrency` tasks at once and at most `maxQueue` waiting; past that `run` fails at
 *  once with LimiterBusyError instead of piling up (load shedding). */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly name: string,
    private readonly concurrency: number,
    private readonly maxQueue: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new LimiterBusyError(this.name);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // the slot passes straight to the next waiter
      else this.active -= 1;
    }
  }
}
