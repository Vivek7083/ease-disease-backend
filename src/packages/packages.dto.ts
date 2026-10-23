import { ApiProperty } from '@nestjs/swagger';

/** Documentation shapes only (what Swagger shows). */
export class PackageItemDto {
  @ApiProperty({ format: 'uuid', example: '00000000-0000-4000-8000-000000000001', description: 'Send this as `packageId` when creating a booking.' })
  id!: string;

  @ApiProperty({ example: 'One-Time Consult' })
  title!: string;

  @ApiProperty({ type: [String], example: ['3-week plan.', 'Understand your underlying root cause.'], description: 'Bullet points to show as they are.' })
  description!: string[];

  @ApiProperty({ type: 'integer', example: 249900, description: 'Price in paise (100 paise = 1 rupee). Display only: the server always charges the stored price.' })
  pricePaise!: number;

  @ApiProperty({ type: 'integer', nullable: true, example: 500000, description: 'The old price to show struck through next to `pricePaise`, or null when there is none. Always higher than `pricePaise` when set. Display only.' })
  originalPricePaise!: number | null;

  @ApiProperty({ enum: ['INR'] })
  currency!: 'INR';

  @ApiProperty({ type: 'integer', example: 30 })
  durationMinutes!: number;
}

export class PackageListResponseDto {
  @ApiProperty({ type: [PackageItemDto], description: 'Packages on sale, cheapest first. Empty when nothing is on sale.' })
  packages!: PackageItemDto[];
}
