import type { CrossingOwner, CrossingStore } from './fastag-crossing.repository';
import type {
  DueOptions,
  FastagTripRow,
  FastagTripStore,
  NewFastagTrip,
} from './fastag-trip.repository';
import type { Crossing } from './ulip.contract';

/** In-memory FastagTripStore + CrossingStore for tests. */
export class MemoryFastagStore implements FastagTripStore, CrossingStore {
  rows: Array<FastagTripRow & { lastPolledAt: Date | null; lastError: string | null }> = [];
  crossings: Array<{ loadId: string; seqNo: string; vehicleNumber: string; crossing: Crossing }> =
    [];

  async liveRows() {
    return this.rows.filter((r) => r.state !== 'ended');
  }

  async insert(input: NewFastagTrip) {
    if (this.rows.some((r) => r.loadId === input.loadId && r.state === 'active')) return null;
    const row = {
      ...input,
      id: `row-${this.rows.length + 1}`,
      state: 'active' as const,
      windowEnd: null,
      attempts: 0,
      lastPolledAt: null,
      lastError: null,
    };
    this.rows.push(row);
    return row;
  }

  async markClosing(id: string, windowEnd: Date) {
    const row = this.rows.find((r) => r.id === id && r.state === 'active');
    if (row) {
      row.state = 'closing';
      row.windowEnd = windowEnd;
    }
  }

  async due(now: Date, { intervalMs, finalDelayMs, limit }: DueOptions) {
    const t = now.getTime();
    return this.rows
      .filter((r) => {
        const polled = r.lastPolledAt?.getTime() ?? null;
        if (r.state === 'active') return polled === null || polled <= t - intervalMs;
        if (r.state !== 'closing') return false;
        const finalAt = r.windowEnd!.getTime() + finalDelayMs;
        return finalAt <= t && (polled === null || polled < finalAt || polled <= t - intervalMs);
      })
      .slice(0, limit);
  }

  async markPolled(id: string, now: Date, result: { error?: string; finish?: 'done' | 'gave_up' }) {
    const row = this.rows.find((r) => r.id === id)!;
    row.lastPolledAt = now;
    row.attempts = result.error ? row.attempts + 1 : 0;
    row.lastError = result.error ?? null;
    if (result.finish && row.state === 'closing') row.state = 'ended';
  }

  async insertMany(owner: CrossingOwner, crossings: Crossing[]) {
    let added = 0;
    for (const crossing of crossings) {
      if (this.crossings.some((c) => c.loadId === owner.loadId && c.seqNo === crossing.seqNo)) {
        continue;
      }
      this.crossings.push({
        loadId: owner.loadId,
        seqNo: crossing.seqNo,
        vehicleNumber: owner.vehicleNumber,
        crossing,
      });
      added++;
    }
    return added;
  }
}
