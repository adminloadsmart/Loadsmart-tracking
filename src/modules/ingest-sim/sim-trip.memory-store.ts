import type { ConsentUpdate, NewSimTrip, SimTripRow, SimTripStore } from './sim-trip.repository';

/** In-memory SimTripStore for tests. */
export class MemoryStore implements SimTripStore {
  rows: SimTripRow[] = [];
  private live = (r: SimTripRow) => !['ended', 'unsupported', 'failed'].includes(r.state);

  async findLiveByTrip(tripId: string) {
    return this.rows.find((r) => r.tripId === tripId && this.live(r)) ?? null;
  }
  async insert(input: NewSimTrip) {
    const row: SimTripRow = {
      ...input,
      id: `row-${this.rows.length + 1}`,
      operator: null,
      consentStatus: 'pending',
      consentSuggestion: null,
      consentRequestedAt: null,
      consentLastCheckedAt: null,
      consentExpiresAt: null,
      state: 'awaiting_consent',
      intugineTripId: null,
      attempts: 0,
      lastError: null,
      startAttempted: false,
    };
    this.rows.push(row);
    return row;
  }
  async updateConsent(id: string, u: ConsentUpdate) {
    const row = this.rows.find((r) => r.id === id)!;
    row.state = u.state;
    row.consentStatus = u.consentStatus ?? row.consentStatus;
    row.operator = u.operator ?? row.operator;
    row.consentLastCheckedAt = u.checkedAt;
    row.consentRequestedAt ??= u.requestedAt ?? null;
    row.consentExpiresAt = u.expiresAt ?? row.consentExpiresAt;
    row.attempts = u.error ? row.attempts + 1 : 0;
    row.lastError = u.error ?? null;
  }
  async awaitingConsentDue(now: Date, intervalMs: number) {
    return this.rows.filter(
      (r) =>
        r.state === 'awaiting_consent' &&
        (!r.consentLastCheckedAt || now.getTime() - r.consentLastCheckedAt.getTime() >= intervalMs),
    );
  }

  async loadsWithFinishedConsent(loadIds: string[]) {
    return new Set(
      this.rows
        .filter((r) => loadIds.includes(r.tripId) && ['unsupported', 'failed'].includes(r.state))
        .map((r) => r.tripId),
    );
  }

  /** Poll results, by row id, for tests. */
  polled = new Map<string, { at: Date; lastPointAt?: Date; error?: string }>();
  async activeDue(now: Date, intervalMs: number, limit: number) {
    return this.rows
      .filter((r) => {
        const last = this.polled.get(r.id)?.at;
        return (
          r.state === 'active' &&
          r.intugineTripId !== null &&
          (!last || now.getTime() - last.getTime() >= intervalMs)
        );
      })
      .slice(0, limit);
  }
  async markPolled(id: string, now: Date, result: { lastPointAt?: Date; error?: string }) {
    this.polled.set(id, { at: now, ...result });
  }

  async liveRows() {
    return this.rows.filter(this.live);
  }
  async activeByPhone(phone: string, exceptTripId: string) {
    return (
      this.rows.find(
        (r) => r.phone === phone && r.tripId !== exceptTripId && r.state === 'active',
      ) ?? null
    );
  }
  async markStarting(id: string) {
    this.rows.find((r) => r.id === id)!.startAttempted = true;
  }
  async markStarted(row: SimTripRow, intugineTripId: string) {
    Object.assign(
      this.rows.find((r) => r.id === row.id)!,
      {
        state: 'active',
        intugineTripId,
        attempts: 0,
      },
    );
  }
  async recordError(id: string, message: string) {
    const row = this.rows.find((r) => r.id === id)!;
    row.attempts += 1;
    row.lastError = message;
  }
  async markEnded(row: SimTripRow, end: Parameters<SimTripStore['markEnded']>[1]) {
    const stored = this.rows.find((r) => r.id === row.id)!;
    stored.state = end.state;
  }
}
