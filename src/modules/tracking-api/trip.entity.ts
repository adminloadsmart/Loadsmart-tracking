import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const TRIP_STATUSES = ['active', 'ended', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];
export const TRIP_PLACE_KINDS = ['loading_point', 'customer_address', 'address'] as const;
export type TripPlaceKind = (typeof TRIP_PLACE_KINDS)[number];

/** A trip created from the tracking screen, tracked without a load (migration 1759770000000). */
@Entity({ schema: 'tracking', name: 'trips' })
export class TrackingTripEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'text' }) code!: string;
  @Column({ type: 'text', default: 'active' }) status!: TripStatus;
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

  @Column({ name: 'created_by', type: 'uuid' }) createdBy!: string;
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true }) endedAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt!: Date;
}
