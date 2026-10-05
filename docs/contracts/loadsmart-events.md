# Contract: `loadsmart.events` stream

The main `loadsmart` backend publishes these events, and `loadsmart-tracking` consumes them to keep its local read models of loads, vehicles, drivers and places up to date. Tracking never reads the main database.

- **Transport:** a Redis Stream named `loadsmart.events` on the main backend's Redis (`MAIN_REDIS_URL` in tracking). Producers append with `XADD loadsmart.events MAXLEN ~ 100000 * <fields>`.
- **Consumer:** consumer group `tracking-sync`, reading at least once.
- **Schema source of truth:** `src/modules/sync/sync.contract.ts` (zod) in this repo.

## Snapshots, not deltas

Every event carries the aggregate's **full current state** plus a `version`. Tracking stores the highest version it has seen and ignores anything older. That means the producer can:
- publish the same state twice, which is harmless;
- deliver events out of order, which is harmless;
- republish everything to rebuild tracking from scratch.

`version` must increase every time the aggregate changes. Use epoch milliseconds of the source row's last change (`updated_at`). For aggregates built from several rows, use the max of their `updated_at` values. For hard deletes, use the time of deletion.

## Stream fields

| Field | Value |
|---|---|
| `type` | `load`, `vehicle`, `driver`, `loading_point` or `delivery_point` |
| `id` | UUID of the aggregate (load id, vehicle id, …) |
| `tenantId` | UUID |
| `version` | Integer epoch ms, as a string |
| `deleted` | `'true'` or `'false'`. Set `'true'` for a hard delete or a soft delete (`deleted_at` set) |
| `payload` | JSON, per type below. Omit it when `deleted='true'` |

## Payloads

**`load`.** One load is one trip. Tracking starts at `loading_confirmed` and ends at `delivered` or `closed`.
```json
{
  "code": "LOAD-0001",
  "status": "created|assigned|loading_confirmed|at_plant|in_transit|reached_delivery_point|delivered|closed",
  "sourceType": "own_fleet|market",
  "vehicleId": "uuid|null",          // own fleet only
  "vehicleNumber": "MH12AB1234|null", // market trucks: the only vehicle identity
  "driverId": "uuid|null",
  "driverNumber": "string|null",
  "driverName": "string|null",
  "transporterId": "uuid|null",
  "loadingPointId": "uuid|null",      // from the requisition
  "deliveryPointId": "uuid|null",     // from the requisition
  "milestones": {
    "loadingConfirmedAt": "ISO|null", "atPlantAt": "ISO|null", "inTransitAt": "ISO|null",
    "reachedDeliveryPointAt": "ISO|null", "deliveredAt": "ISO|null"
  }
}
```

**`vehicle`.** Built from `masters.vehicles` plus `masters.vehicle_telemetry_meta`.
```json
{ "registrationNumber": "MH12AB1234", "status": "string|null", "gpsProvider": "string|null", "gpsEnabled": true }
```

**`driver`.**
```json
{ "fullName": "string", "phoneNumber": "string", "status": "string|null" }
```

**`loading_point`** and **`delivery_point`** share one normalized place shape:
```json
{ "name": "string", "address": "string|null", "city": "string|null", "state": "string|null",
  "pinCode": "string|null", "lat": 28.61, "lng": 77.2 }
```
- For a `loading_point`, `name` is the loading point's `title`.
- For a `delivery_point`, `name` is its `location`, and `lat`/`lng` are `null` because the main backend doesn't store coordinates for delivery points yet.

## Rules for the producer
- Publish after the change is committed. Snapshots are rebuilt from current DB state at publish time, so a slow relay can never publish an old state with a new version.
- On a validation error, tracking dead-letters that entry to `loadsmart.events:dlq` and carries on.
- Republishing every snapshot is always safe. Use it to backfill and to recover.
