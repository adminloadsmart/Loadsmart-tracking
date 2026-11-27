import { describe, expect, it, vi } from 'vitest';
import { BatchHook, composeHooks } from './point-processing.service';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('composeHooks', () => {
  it('runs the hooks concurrently and merges their state writes', async () => {
    const events: string[] = [];
    const hook = (name: string, ms: number): BatchHook => ({
      async run() {
        events.push(`start:${name}`);
        await delay(ms);
        events.push(`end:${name}`);
        return { writeState: (multi: any) => multi.calls.push(name) };
      },
    });
    const composed = composeHooks(hook('rules', 30), hook('geofences', 10), hook('start', 1));
    const result = await composed.run([], 0);
    expect(events.slice(0, 3)).toEqual(['start:rules', 'start:geofences', 'start:start']);
    const multi = { calls: [] as string[] };
    result.writeState?.(multi as any);
    expect(multi.calls).toEqual(['rules', 'geofences', 'start']);
  });

  it('a failing hook fails the batch only after the others have finished', async () => {
    let otherDone = false;
    const composed = composeHooks(
      {
        async run() {
          throw new Error('rules down');
        },
      },
      {
        async run() {
          await delay(20);
          otherDone = true;
          return {};
        },
      },
    );
    await expect(composed.run([], 0)).rejects.toThrow('rules down');
    expect(otherDone).toBe(true);
  });

  it('runs every after-commit step even when one fails', async () => {
    const second = vi.fn(async () => {});
    const composed = composeHooks(
      { run: async () => ({ afterCommit: async () => Promise.reject(new Error('publish')) }) },
      { run: async () => ({ afterCommit: second }) },
    );
    const result = await composed.run([], 0);
    await expect(result.afterCommit?.()).rejects.toThrow('publish');
    expect(second).toHaveBeenCalled();
  });
});
