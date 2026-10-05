// src/db/data-source.ts
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';

// Metadata tables only (trip/vehicle read models, settings, trip_source_link, ...). The
// high-volume location_points hypertable is written with raw pg bulk inserts, not TypeORM entities
// (see docs/ROADMAP.md §6).
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.databaseUrl,
  // Schema changes are managed by migrations only — Timescale hypertables, compression and
  // retention policies can't be expressed by synchronize anyway.
  synchronize: false,
  logging: false,
  entities: [], // every new module adds its entity here
  // __dirname-relative + dual-ext so this resolves under ts-node (src/db) and compiled node (dist/db).
  migrations: [`${__dirname}/migrations/*.{js,ts}`],
  // Per-migration transactions: Timescale DDL like continuous aggregates must run outside one,
  // and those migrations opt out with `transaction = false`.
  migrationsTransactionMode: 'each',
  extra: {
    // Bounded pool — the hot ingest paths never touch Postgres synchronously (they XADD to Redis),
    // so a small pool per process is enough and protects the DB as roles scale out horizontally.
    max: 10,
  },
});
