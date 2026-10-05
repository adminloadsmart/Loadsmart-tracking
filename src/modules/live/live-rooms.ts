// /live room names. Tenant isolation rests on these: a socket only ever joins rooms for
// resources its subscribe() call verified against the caller's tenant scope.
export const ALL_TENANTS_ROOM = 'all-tenants';
export const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;
export const vehicleRoom = (vehicleId: string) => `vehicle:${vehicleId}`;
export const tripRoom = (tripId: string) => `trip:${tripId}`;
