export interface SeedLoadInput {
  tenantId: string;
  status?: string;
  /** loads.tracking_source as the main backend set it (gps | driver_app | sim | fastag). */
  trackingSource?: string | null;
  sourceType?: 'own_fleet' | 'market';
  vehicleId?: string;
  /** Market trucks: no vehicle row, only the plate on the load. */
  vehicleNumber?: string;
  registrationNumber?: string;
  bodyType?: string | null;
  driverId?: string | null;
  driverName?: string | null;
  driverNumber?: string | null;
  customerName?: string;
  plannedTonnes?: number | null;
  startedAt?: Date | null;
  deliveredAt?: Date | null;
  expectedDeliveryDate?: string; // YYYY-MM-DD
  origin?: { lat: number; lng: number } | null;
  destination?: {
    location: string;
    address?: string;
    city?: string;
    state?: string;
    pinCode?: string;
  };
  code?: string;
}

export interface SeededLoad {
  loadId: string;
  vehicleId: string | null;
  driverId: string | null;
  loadingPointId: string;
  deliveryPointId: string;
}
