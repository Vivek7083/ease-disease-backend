import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Documentation shapes only (what Swagger shows). The service validates by hand and returns plain objects. */
export class CreateBookingRequestDto {
  @ApiProperty({ format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'The package to book. Its current price is copied onto the booking; the caller never sends a price.' })
  packageId!: string;

  @ApiProperty({ minLength: 2, maxLength: 100, example: 'Priya Sharma', description: 'Who the consultation is for. May differ from the signed-in account.' })
  name!: string;

  @ApiProperty({ example: '+91 98765 43210', description: 'With the country code after a `+`, any country. Spaces, dashes, dots and brackets are removed; stored as E.164.' })
  whatsappNumber!: string;

  @ApiProperty({ maxLength: 50, example: 'priya@example.com', description: 'Lower-cased. At most 50 characters and in the form PayU accepts.' })
  email!: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 119, example: 34 })
  age!: number;

  @ApiProperty({ minLength: 2, maxLength: 100, example: 'Bengaluru' })
  city!: string;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 50, example: 'Female', description: 'Free text. Empty or blank becomes null.' })
  gender?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 1000, example: 'Bloating after meals' })
  notes?: string | null;

  @ApiProperty({ enum: [true], example: true, description: 'Must be exactly `true`.' })
  consent!: true;
}

export class BookingDto {
  @ApiProperty({ example: 'ED-7K3QXM' })
  reference!: string;

  @ApiProperty({ enum: ['PENDING_PAYMENT'] })
  status!: 'PENDING_PAYMENT';

  @ApiProperty({ example: 'One-Time Consult' })
  packageTitle!: string;

  @ApiProperty({ example: 249900, description: 'Integer paise, the package price at the moment of booking.' })
  amountPaise!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 'Priya Sharma' })
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  whatsappNumber!: string;

  @ApiProperty({ example: 'priya@example.com' })
  email!: string;

  @ApiProperty({ example: 34 })
  age!: number;

  @ApiProperty({ example: 'Bengaluru' })
  city!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Female' })
  gender!: string | null;

  @ApiProperty({ example: true, description: 'Whether a payment form can be requested now: the booking is waiting for payment and no payment is in progress or decided.' })
  canPay!: boolean;

  @ApiProperty({ nullable: true, type: Object, example: null, description: 'Always null on a new booking.' })
  payment!: null;

  @ApiProperty({ example: '2026-10-22T10:00:00.123Z', description: 'When the booking was created (ISO-8601 UTC).' })
  createdAt!: string;
}

export class CreateBookingResponseDto {
  @ApiProperty({ type: BookingDto })
  booking!: BookingDto;
}

const BOOKING_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'NEEDS_ATTENTION', 'FAILED'];
const PAYMENT_STATUSES = ['CREATED', 'INITIATED', 'SUCCESS', 'FAILURE', 'PENDING', 'CANCELLED', 'EXPIRED'];

export class BookingListItemDto {
  @ApiProperty({ example: 'ED-7K3QXM' })
  reference!: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status!: string;

  @ApiProperty({ example: 'One-Time Consult' })
  packageTitle!: string;

  @ApiProperty({ example: 249900 })
  amountPaise!: number;

  @ApiProperty({ nullable: true, enum: PAYMENT_STATUSES, type: String, description: 'The payment record status, or null before a payment was started.' })
  paymentStatus!: string | null;

  @ApiProperty({ example: false, description: 'Same rule as the booking detail.' })
  canPay!: boolean;

  @ApiProperty({ example: '2026-10-22T10:00:00.123Z' })
  createdAt!: string;
}

export class BookingListResponseDto {
  @ApiProperty({ type: [BookingListItemDto] })
  items!: BookingListItemDto[];

  @ApiProperty({ nullable: true, type: String, description: 'Pass as `cursor` to get the next page; null on the last page.' })
  nextCursor!: string | null;
}

export class PaymentDto {
  @ApiProperty({ example: 'EDTX01JBTESTTXN000000001', description: 'The PayU transaction id.' })
  orderId!: string;

  @ApiProperty({ enum: PAYMENT_STATUSES })
  status!: string;

  @ApiProperty({ nullable: true, type: String, example: 'UPI' })
  mode!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '2026-10-22T10:05:00.000Z', description: 'Only for a payment PayU confirmed.' })
  paidAt!: string | null;
}

export class BookingDetailDto {
  @ApiProperty({ example: 'ED-7K3QXM' })
  reference!: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status!: string;

  @ApiProperty({ example: 'One-Time Consult' })
  packageTitle!: string;

  @ApiProperty({ example: 249900, description: 'Integer paise, the package price at the moment of booking.' })
  amountPaise!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 'Priya Sharma', description: 'Who the consultation is for, as typed on the booking form.' })
  name!: string;

  @ApiProperty({ example: '+919876543210' })
  whatsappNumber!: string;

  @ApiProperty({ example: 'priya@example.com' })
  email!: string;

  @ApiProperty({ example: 34 })
  age!: number;

  @ApiProperty({ example: 'Bengaluru' })
  city!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Female' })
  gender!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Bloating after meals' })
  notes!: string | null;

  @ApiProperty({ example: true, description: 'Whether a payment form can be requested now: the booking is waiting for payment and no payment is in progress or decided.' })
  canPay!: boolean;

  @ApiProperty({ nullable: true, type: PaymentDto, description: 'Null before a payment was started.' })
  payment!: PaymentDto | null;

  @ApiProperty({ example: '2026-10-22T10:00:00.123Z' })
  createdAt!: string;
}

export class BookingDetailResponseDto {
  @ApiProperty({ type: BookingDetailDto })
  booking!: BookingDetailDto;
}
