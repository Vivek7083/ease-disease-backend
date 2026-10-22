import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { mapSignInProvider, type AuthProvider } from './auth-provider.js';
import { cleanTokenName, normaliseTokenEmail } from './token-profile.js';

/** What the API returns about a person. Never the Firebase uid, never timestamps. */
export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  /** `YYYY-MM-DD` */
  dob: string | null;
  /** How they first signed up. */
  authProvider: AuthProvider;
  /** How they signed in most recently (changed by `/auth/sync` only). */
  lastAuthProvider: AuthProvider;
}

export interface ProfileResponse {
  user: UserProfile;
  profileComplete: boolean;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  dob: string | null;
  auth_provider: AuthProvider;
  last_auth_provider: AuthProvider;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `POST /v1/auth/sync`: creates or refreshes the row for this Firebase account in ONE statement
   * (`INSERT ... ON CONFLICT`), so two simultaneous first calls cannot create two rows or fail. Email follows the
   * verified token; the name is taken from the token only while the stored one is empty; the first sign-up method is
   * never rewritten; the latest one and `last_login_at` are.
   */
  async syncFromIdentity(identity: VerifiedIdentity): Promise<ProfileResponse> {
    const { email, provider } = this.accept(identity);
    const name = cleanTokenName(identity.name) ?? null;
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      INSERT INTO users (id, firebase_uid, email, name, auth_provider, last_auth_provider, last_login_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${identity.uid}, ${email}, ${name}::text, ${provider}, ${provider}, now(), now())
      ON CONFLICT (firebase_uid) DO UPDATE SET
        email = EXCLUDED.email,
        name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name),
        last_auth_provider = EXCLUDED.last_auth_provider,
        last_login_at = now(),
        updated_at = now()
      RETURNING id, email, name, phone, to_char(dob, 'YYYY-MM-DD') AS dob, auth_provider, last_auth_provider`;
    return this.toResponse(this.single(rows));
  }

  /**
   * `GET /v1/me`: returns the stored profile and changes nothing. Only when the row is missing (a valid token whose
   * sync never ran) is it created, exactly as sync would create it.
   */
  async findOrCreateFromIdentity(identity: VerifiedIdentity): Promise<ProfileResponse> {
    const existing = await this.select(identity.uid);
    if (existing) return this.toResponse(existing);

    const { email, provider } = this.accept(identity);
    const name = cleanTokenName(identity.name) ?? null;
    await this.prisma.$executeRaw`
      INSERT INTO users (id, firebase_uid, email, name, auth_provider, last_auth_provider, last_login_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${identity.uid}, ${email}, ${name}::text, ${provider}, ${provider}, now(), now())
      ON CONFLICT (firebase_uid) DO NOTHING`;
    const created = await this.select(identity.uid);
    return this.toResponse(this.single(created ? [created] : []));
  }

  private async select(firebaseUid: string): Promise<UserRow | undefined> {
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT id, email, name, phone, to_char(dob, 'YYYY-MM-DD') AS dob, auth_provider, last_auth_provider
      FROM users WHERE firebase_uid = ${firebaseUid}`;
    return rows[0];
  }

  /** The two things a sign-in must satisfy before any row is written. */
  private accept(identity: VerifiedIdentity): { email: string; provider: AuthProvider } {
    const provider = mapSignInProvider(identity.signInProvider);
    if (!provider) {
      throw new AppException('UNSUPPORTED_SIGN_IN_PROVIDER', 'This sign-in method is not supported', HttpStatus.FORBIDDEN);
    }
    const email = normaliseTokenEmail(identity.email);
    if (!email) {
      throw new AppException('INVALID_EMAIL', 'This email address cannot be used', HttpStatus.BAD_REQUEST);
    }
    return { email, provider };
  }

  private single(rows: UserRow[]): UserRow {
    const row = rows[0];
    if (!row) throw new Error('users upsert returned no row');
    return row;
  }

  private toResponse(row: UserRow): ProfileResponse {
    const user: UserProfile = {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      dob: row.dob,
      authProvider: row.auth_provider,
      lastAuthProvider: row.last_auth_provider,
    };
    return { user, profileComplete: Boolean(user.name) && Boolean(user.phone) };
  }
}
