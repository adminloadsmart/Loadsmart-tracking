import type { ConsentUpdate, NewSimTrip, SimTripRow, SimTripStore } from './sim-trip.repository';

/** In-memory SimTripStore for tests. */
export class MemoryStore implements SimTripStore {
  rows: SimTripRow[] = [];
  private live = (r: SimTripRow) => !['ended', 'unsupported', 'failed'].includes(r.state);

  async findLiveByTrip(tripId: string) {
    return this.rows.find((r) => r.tripId === tripId && this.live(r)) ?? null;
  }
  async findLatestByTrip(tripId: string) {
    return [...this.rows].reverse().find((r) => r.tripId === tripId) ?? null;
  }
  async insert(input: NewSimTrip) {
    const { reusedConsent, ...rest } = input;
    const row: SimTripRow = {
      ...rest,
      id: `row-${this.rows.length + 1}`,
      operator: null,
      consentReused: reusedConsent ?? false,
      consentStage: 0,
      endReason: null,
      createdAt: new Date(),
      consentStatus: reusedConsent ? 'allowed' : 'pending',
      consentSuggestion: null,
      consentRequestedAt: null,
      consentLastCheckedAt: null,
      consentExpiresAt: null,
      state: reusedConsent ? 'consented' : 'awaiting_consent',
      intugineTripId: null,
      carriedIntugineTripId: null,
      attempts: 0,
      lastError: null,
      startAttempted: false,
    };
    this.rows.push(row);
    return row;
  }
  async handOver(
    row: SimTripRow,
    next: { phone: string; driverId: string | null; reusedConsent: boolean },
  ) {
    const stored = this.rows.find((r) => r.id === row.id);
    if (!stored || !this.live(stored)) return null;
    const carried = row.intugineTripId ?? row.carriedIntugineTripId;
    stored.state = 'ended';
    stored.endReason = 'driver_changed';
    stored.carriedIntugineTripId = null;
    const created = await this.insert({
      tenantId: row.tenantId,
      tripId: row.tripId,
      vehicleId: row.vehicleId,
      driverId: next.driverId,
      phone: next.phone,
      reusedConsent: next.reusedConsent,
    });
    created.carriedIntugineTripId = carried;
    return created;
  }
  async finishedWithCarriedTrip() {
    return this.rows.filter((r) => r.carriedIntugineTripId && !this.live(r));
  }
  async clearCarried(id: string) {
    this.rows.find((r) => r.id === id)!.carriedIntugineTripId = null;
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
    if (u.endReason) row.endReason = u.endReason;
  }
  async setConsentStage(id: string, stage: number) {
    const row = this.rows.find((r) => r.id === id)!;
    row.consentStage = Math.max(row.consentStage, stage);
  }
  async awaitingConsentDue(now: Date, intervalMs: number) {
    return this.rows.filter(
      (r) =>
        r.state === 'awaiting_consent' &&
        (!r.consentLastCheckedAt || now.getTime() - r.consentLastCheckedAt.getTime() >= intervalMs),
    );
  }

  async loadsWithFinishedConsent(loads: Array<{ id: string; phone: string | null }>) {
    return new Set(
      this.rows
        .filter(
          (r) =>
            loads.some((l) => l.id === r.tripId && l.phone === r.phone) &&
            ['unsupported', 'failed'].includes(r.state),
        )
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
        carriedIntugineTripId: null,
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
    stored.endReason = end.reason;
  }
}
