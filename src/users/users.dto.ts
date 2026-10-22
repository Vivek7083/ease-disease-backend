import { ApiProperty } from '@nestjs/swagger';

/** Documentation shapes only (what Swagger shows). The service returns plain objects with the same fields. */
export class UserProfileDto {
  @ApiProperty({ format: 'uuid', example: '7b1e2c34-5d6f-4a89-b0c1-d2e3f4a5b6c7' })
  id!: string;

  @ApiProperty({ example: 'priya@example.com', description: 'Lower-case. Follows the verified email of the latest sign-in.' })
  email!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Priya Sharma', description: 'Filled from the sign-in token only while empty; an edited name is never overwritten.' })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+919876543210', description: 'E.164. Null until set.' })
  phone!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1990-04-12', description: 'YYYY-MM-DD. Null until set.' })
  dob!: string | null;

  @ApiProperty({ enum: ['google.com', 'emailLink'], description: 'How the person FIRST signed up. Never changes.' })
  authProvider!: 'google.com' | 'emailLink';

  @ApiProperty({ enum: ['google.com', 'emailLink'], description: 'How they signed in most recently (changed by POST /v1/auth/sync only).' })
  lastAuthProvider!: 'google.com' | 'emailLink';
}

export class ProfileResponseDto {
  @ApiProperty({ type: UserProfileDto })
  user!: UserProfileDto;

  @ApiProperty({ example: false, description: 'True when both name and phone are present. Informational only; it does not gate booking.' })
  profileComplete!: boolean;
}

class ErrorBodyDto {
  @ApiProperty({ example: 'UNAUTHENTICATED' })
  code!: string;

  @ApiProperty({ example: 'Authentication required' })
  message!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, example: {} })
  details!: Record<string, unknown>;

  @ApiProperty({ example: 'a47d87c3-331c-42c6-be2d-9c4a3e83d3ef' })
  requestId!: string;
}

/** The standard error envelope from api-flow.md section 3. */
export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}
