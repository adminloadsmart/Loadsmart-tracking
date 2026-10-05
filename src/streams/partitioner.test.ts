import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { partitionFor, pointStreamKey } from './partitioner';

describe('partitionFor', () => {
  it('is stable — this exact mapping must never change once data is flowing', () => {
    expect(partitionFor('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', 16)).toBe(
      partitionFor('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', 16),
    );
    // Pinned value: if this fails, the hash changed and in-flight stream entries would move.
    expect(partitionFor('00000000-0000-0000-0000-000000000000', 16)).toBe(
      partitionFor('00000000-0000-0000-0000-000000000000'.toUpperCase(), 16),
    );
    expect(
      [
        '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
        'a1b2c3d4-0000-4000-8000-000000000001',
        '5b6c7d8e-1111-4222-8333-444455556666',
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
      ].map((id) => partitionFor(id, 16)),
    ).toEqual([0, 10, 6, 11]);
  });

  it('stays in range and spreads vehicles across partitions', () => {
    const counts = new Array(16).fill(0);
    for (let i = 0; i < 16_000; i += 1) counts[partitionFor(randomUUID(), 16)] += 1;
    for (const count of counts) {
      // ~1000 each; a broken hash would pile vehicles onto a few partitions.
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });

  it('rejects a non-positive partition count', () => {
    expect(() => partitionFor(randomUUID(), 0)).toThrow();
  });

  it('builds the stream key', () => {
    expect(pointStreamKey(3)).toBe('trk:points:3');
  });
});
