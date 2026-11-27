/**
 * A Map with a size cap: past `maxSize`, the least recently used entry is dropped. For in-process
 * caches keyed by vehicle / trip / tenant, which otherwise grow for the life of the process. Only
 * for data that is reloaded when missing — an evicted entry is just a cache miss.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error(`maxSize must be a positive integer, got ${maxSize}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Map keeps insertion order: re-inserting moves the key to the newest end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value as K);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
