import { DataSource } from 'typeorm';
import type { ConsentRecord } from './sim-consent.record';

/** What the consent flow needs from storage for the per-number consent (a fake in tests). */
export interface SimConsentStore {
  find(phone: string): Promise<ConsentRecord | null>;
  /** Inserts or replaces the number's record. */
  save(record: ConsentRecord): Promise<void>;
}

const COLUMNS = `
  phone, operator, status, suggestion, first_sent_at AS "firstSentAt", sent_at AS "sentAt",
  given_at AS "givenAt", valid_until AS "validUntil", withdrawn_at AS "withdrawnAt",
  last_checked_at AS "lastCheckedAt"`;

/** SQL for tracking.sim_consents (see the SimConsents migration). */
export class SimConsentRepository implements SimConsentStore {
  constructor(private readonly dataSource: DataSource) {}

  async find(phone: string): Promise<ConsentRecord | null> {
    const rows: ConsentRecord[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.sim_consents WHERE phone = $1`,
      [phone],
    );
    return rows[0] ?? null;
  }

  async save(record: ConsentRecord): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO tracking.sim_consents
         (phone, operator, status, suggestion, first_sent_at, sent_at, given_at, valid_until,
          withdrawn_at, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (phone) DO UPDATE SET
         operator = EXCLUDED.operator, status = EXCLUDED.status, suggestion = EXCLUDED.suggestion,
         first_sent_at = EXCLUDED.first_sent_at, sent_at = EXCLUDED.sent_at,
         given_at = EXCLUDED.given_at, valid_until = EXCLUDED.valid_until,
         withdrawn_at = EXCLUDED.withdrawn_at, last_checked_at = EXCLUDED.last_checked_at,
         updated_at = now()`,
      [
        record.phone,
        record.operator,
        record.status,
        record.suggestion,
        record.firstSentAt,
        record.sentAt,
        record.givenAt,
        record.validUntil,
        record.withdrawnAt,
        record.lastCheckedAt,
      ],
    );
  }
}

/** In-memory SimConsentStore for tests. */
export class MemoryConsentStore implements SimConsentStore {
  records = new Map<string, ConsentRecord>();
  async find(phone: string) {
    const record = this.records.get(phone);
    return record ? { ...record } : null;
  }
  async save(record: ConsentRecord) {
    this.records.set(record.phone, { ...record });
  }
}
