import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import type { SeededLoad, SeedLoadInput } from './types/main-schema';

/** Inserts a load (with vehicle, truck type, places and requisition) as the main backend would. */
export async function seedLoad(ds: DataSource, input: SeedLoadInput): Promise<SeededLoad> {
  const tenantId = input.tenantId;
  const sourceType = input.sourceType ?? 'own_fleet';
  const [loadId, loadingPointId, deliveryPointId, requisitionId, customerId] = [1, 2, 3, 4, 5].map(
    () => randomUUID(),
  );
  let vehicleId: string | null = null;
  if (sourceType === 'own_fleet') {
    vehicleId = input.vehicleId ?? randomUUID();
    let truckTypeId: string | null = null;
    if (input.bodyType) {
      truckTypeId = randomUUID();
      await ds.query(
        `INSERT INTO masters.truck_types (id, tenant_id, name, body_type) VALUES ($1, $2, $3, $4)`,
        [truckTypeId, tenantId, `${input.bodyType} truck`, input.bodyType],
      );
    }
    await ds.query(
      `INSERT INTO masters.vehicles (id, tenant_id, registration_number, truck_type_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [vehicleId, tenantId, input.registrationNumber ?? 'MH12AB0001', truckTypeId],
    );
  }
  const origin = input.origin === undefined ? { lat: 28.6, lng: 77.2 } : input.origin;
  await ds.query(
    `INSERT INTO masters.loading_points (id, tenant_id, title, address_line_1, city, state, pin_code, latitude, longitude)
     VALUES ($1, $2, 'Plant', 'Plot 1', 'Delhi', 'DL', '110001', $3, $4)`,
    [loadingPointId, tenantId, origin?.lat ?? null, origin?.lng ?? null],
  );
  await ds.query(`INSERT INTO customers.customers (id, tenant_id, name) VALUES ($1, $2, $3)`, [
    customerId,
    tenantId,
    input.customerName ?? 'ACME Ltd',
  ]);
  const destination = input.destination ?? { location: 'ACME DC' };
  await ds.query(
    `INSERT INTO customers.customer_delivery_points (id, tenant_id, customer_id, location, address_line_1, city, state, pin_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      deliveryPointId,
      tenantId,
      customerId,
      destination.location,
      destination.address ?? null,
      destination.city ?? null,
      destination.state ?? null,
      destination.pinCode ?? null,
    ],
  );
  await ds.query(
    `INSERT INTO loads.requisitions (id, tenant_id, customer_id, loading_point_id, customer_delivery_point_id, expected_delivery_date)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      requisitionId,
      tenantId,
      customerId,
      loadingPointId,
      deliveryPointId,
      input.expectedDeliveryDate ?? '2099-01-01',
    ],
  );
  const driverId = input.driverId === undefined ? randomUUID() : input.driverId;
  const started =
    input.startedAt === undefined ? new Date(Date.now() - 3_600_000) : input.startedAt;
  await ds.query(
    `INSERT INTO loads.loads (id, tenant_id, code, status, source_type, requisition_id, vehicle_id, vehicle_number,
       driver_id, driver_name, driver_number, planned_capacity_tonnes, loading_confirmed_at,
       delivered_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp())`,
    [
      loadId,
      tenantId,
      input.code ?? 'LOAD-T1',
      input.status ?? 'in_transit',
      sourceType,
      requisitionId,
      vehicleId,
      input.vehicleNumber ?? input.registrationNumber ?? 'MH12AB0001',
      driverId,
      input.driverName ?? null,
      input.driverNumber ?? null,
      input.plannedTonnes ?? null,
      started,
      input.deliveredAt ?? null,
    ],
  );
  return { loadId, vehicleId, driverId, loadingPointId, deliveryPointId };
}

/** Updates a load the way main's TypeORM would (bumping updated_at). */
export async function updateLoad(
  ds: DataSource,
  loadId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((column, index) => `${column} = $${index + 2}`).join(', ');
  await ds.query(`UPDATE loads.loads SET ${sets}, updated_at = clock_timestamp() WHERE id = $1`, [
    loadId,
    ...keys.map((column) => fields[column]),
  ]);
}
