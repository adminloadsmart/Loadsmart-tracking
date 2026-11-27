import { describe, expect, it } from 'vitest';
import { LruMap } from './lru';

describe('LruMap', () => {
  it('drops the least recently used entry past maxSize', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1).set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the newest
    lru.set('c', 3);
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('overwriting a key does not grow it, and refreshes it', () => {
    const lru = new LruMap<string, number>(2);
    lru.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe(10);
  });

  it('rejects a non-positive size', () => {
    expect(() => new LruMap(0)).toThrow();
  });
});
