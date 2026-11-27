import { describe, expect, it } from 'vitest';
import { Limiter, LimiterBusyError, mapWithConcurrency, SerialQueue } from './concurrency';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 2, async (ms, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await delay(ms);
      running -= 1;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('SerialQueue', () => {
  it('never overlaps tasks, and a failing task does not block the next', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    const task =
      (name: string, ms: number, fail = false) =>
      async () => {
        events.push(`start:${name}`);
        await delay(ms);
        events.push(`end:${name}`);
        if (fail) throw new Error(name);
        return name;
      };
    const a = queue.run(task('a', 20, true));
    const b = queue.run(task('b', 1));
    await expect(a).rejects.toThrow('a');
    expect(await b).toBe('b');
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});

describe('Limiter', () => {
  it('runs at most `concurrency` at once, queues up to maxQueue, and sheds the rest', async () => {
    const limiter = new Limiter('test', 1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = limiter.run(() => gate.then(() => 'first'));
    const second = limiter.run(async () => 'second'); // queued
    await expect(limiter.run(async () => 'third')).rejects.toBeInstanceOf(LimiterBusyError);
    release();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(await limiter.run(async () => 'again')).toBe('again'); // slots were returned
  });
});
