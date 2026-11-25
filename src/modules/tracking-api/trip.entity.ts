import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A created trip's stages, moved on automatically by its pings and geofences (migration
 * 1759790000000): saved → first ping → pickup geofence entered / left → drop geofence entered →
 * a second point inside the drop geofence completes it. Cancelled is set by hand (Stop tracking).
 */
export const RUNNING_TRIP_STATUSES = [
  'waiting_first_ping',
  'heading_to_pickup',
  'at_pickup',
  'in_transit',
  'at_drop',
] as const;
export const TRIP_STATUSES = [...RUNNING_TRIP_STATUSES, 'completed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export type RunningTripStatus = (typeof RUNNING_TRIP_STATUSES)[number];
export const isRunningTrip = (status: TripStatus): status is RunningTripStatus =>
  (RUNNING_TRIP_STATUSES as readonly string[]).includes(status);
export const TRIP_PLACE_KINDS = ['loading_point', 'customer_address', 'address'] as const;
export type TripPlaceKind = (typeof TRIP_PLACE_KINDS)[number];

/** A trip created from the tracking screen, tracked without a load (migration 1759770000000). */
@Entity({ schema: 'tracking', name: 'trips' })
export class TrackingTripEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) code!: string;
  @Column({ type: 'text', default: 'waiting_first_ping' }) status!: TripStatus;
  @Column({ type: 'text', nullable: true }) direction!: 'in' | 'out' | null;

  @Column({ name: 'customer_id', type: 'uuid', nullable: true }) customerId!: string | null;
  @Column({ name: 'customer_name', type: 'text', nullable: true }) customerName!: string | null;

  @Column({ name: 'origin_kind', type: 'text' }) originKind!: TripPlaceKind;
  @Column({ name: 'origin_ref_id', type: 'uuid', nullable: true }) originRefId!: string | null;
  @Column({ name: 'origin_name', type: 'text' }) originName!: string;
  @Column({ name: 'origin_address', type: 'text' }) originAddress!: string;
  @Column({ name: 'origin_city', type: 'text', nullable: true }) originCity!: string | null;
  @Column({ name: 'destination_kind', type: 'text' }) destinationKind!: TripPlaceKind;
  @Column({ name: 'destination_ref_id', type: 'uuid', nullable: true })
  destinationRefId!: string | null;
  @Column({ name: 'destination_name', type: 'text' }) destinationName!: string;
  @Column({ name: 'destination_address', type: 'text' }) destinationAddress!: string;
  @Column({ name: 'destination_city', type: 'text', nullable: true })
  destinationCity!: string | null;

  @Column({ name: 'vehicle_number', type: 'text' }) vehicleNumber!: string;
  @Column({ name: 'driver_phone', type: 'text' }) driverPhone!: string;
  @Column({ name: 'driver_name', type: 'text', nullable: true }) driverName!: string | null;
  @Column({ name: 'driver_licence_number', type: 'text', nullable: true })
  driverLicenceNumber!: string | null;
  @Column({ name: 'driver_date_of_birth', type: 'date', nullable: true })
  driverDateOfBirth!: string | null;
  @Column({ name: 'transporter_id', type: 'uuid', nullable: true }) transporterId!: string | null;
  @Column({ name: 'transporter_name', type: 'text', nullable: true })
  transporterName!: string | null;
  @Column({ name: 'transporter_phone', type: 'text', nullable: true })
  transporterPhone!: string | null;

  @Column({ name: 'loading_reporting_at', type: 'timestamptz', nullable: true })
  loadingReportingAt!: Date | null;
  @Column({ name: 'delivery_mode', type: 'text', nullable: true })
  deliveryMode!: 'reporting' | 'appointment' | null;
  @Column({ name: 'delivery_reporting_at', type: 'timestamptz', nullable: true })
  deliveryReportingAt!: Date | null;
  @Column({ name: 'appointment_ref', type: 'text', nullable: true }) appointmentRef!: string | null;
  @Column({ name: 'appointment_from', type: 'timestamptz', nullable: true })
  appointmentFrom!: Date | null;
  @Column({ name: 'appointment_to', type: 'timestamptz', nullable: true })
  appointmentTo!: Date | null;
  @Column({ name: 'eway_bill_number', type: 'text', nullable: true })
  ewayBillNumber!: string | null;
  @Column({ name: 'eway_bill_valid_till', type: 'timestamptz', nullable: true })
  ewayBillValidTill!: Date | null;

  // How the trip is tracked, decided when it is created (migration 1759780000000). NULL on trips
  // created before then: those stay display-only.
  /** Fleet vehicle with this plate, else the market id derived from the plate (marketVehicleId). */
  @Column({ name: 'vehicle_id', type: 'uuid', nullable: true }) vehicleId!: string | null;
  @Column({ name: 'own_fleet', type: 'boolean', default: false }) ownFleet!: boolean;
  /** The one driver account with this mobile number, if exactly one has it. */
  @Column({ name: 'driver_id', type: 'uuid', nullable: true }) driverId!: string | null;
  @Column({ name: 'tracking_source', type: 'text', nullable: true })
  trackingSource!: 'gps' | 'driver_app' | 'sim' | 'fastag' | null;

  // Migration 1759790000000. Each end's coordinates: the picked master's pin, else its address
  // geocoded (null when it couldn't be).
  @Column({ name: 'origin_lat', type: 'double precision', nullable: true })
  originLat!: number | null;
  @Column({ name: 'origin_lng', type: 'double precision', nullable: true })
  originLng!: number | null;
  @Column({ name: 'destination_lat', type: 'double precision', nullable: true })
  destinationLat!: number | null;
  @Column({ name: 'destination_lng', type: 'double precision', nullable: true })
  destinationLng!: number | null;
  /** When the truck entered / left the pickup's geofence, and entered the drop's. */
  @Column({ name: 'arrived_pickup_at', type: 'timestamptz', nullable: true })
  arrivedPickupAt!: Date | null;
  @Column({ name: 'departed_pickup_at', type: 'timestamptz', nullable: true })
  departedPickupAt!: Date | null;
  @Column({ name: 'arrived_drop_at', type: 'timestamptz', nullable: true })
  arrivedDropAt!: Date | null;
  @Column({ name: 'lr_number', type: 'text', nullable: true }) lrNumber!: string | null;
  /** The VAHAN result Create trip got for the truck: verified (all papers valid), non_compliant,
   *  not_found, ... (null: not run). */
  @Column({ name: 'vahan_status', type: 'text', nullable: true }) vahanStatus!: string | null;

  /** The truck's RC photo (storage key, purpose masters/vehicle), uploaded when VAHAN failed. */
  @Column({ name: 'rc_key', type: 'text', nullable: true }) rcKey!: string | null;
  /** The Sarathi check Create trip ran on the driver's licence (verified, manual_review, ...). */
  @Column({ name: 'dl_status', type: 'text', nullable: true }) dlStatus!: string | null;
  /** The licence's front / back photos (storage keys, purpose masters/driver), uploaded when
   *  Sarathi couldn't confirm it, for a manual check. */
  @Column({ name: 'dl_front_key', type: 'text', nullable: true }) dlFrontKey!: string | null;
  @Column({ name: 'dl_back_key', type: 'text', nullable: true }) dlBackKey!: string | null;

  @Column({ name: 'created_by', type: 'uuid' }) createdBy!: string;
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true }) endedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
