import { Controller, Get, Header, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppCheckGuard } from '../auth/app-check.guard.js';
import { CurrentIdentity } from '../auth/current-identity.decorator.js';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard.js';
import type { VerifiedIdentity } from '../auth/identity-verifier.js';
import { UsersService, type ProfileResponse } from './users.service.js';

/** Personal data: browsers and proxies must not keep a copy. */
const NO_STORE = 'no-store';

@ApiTags('auth')
@Controller('v1')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Called right after every sign-in. App Check is checked first, then the login token. */
  @Post('auth/sync')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', NO_STORE)
  @UseGuards(AppCheckGuard, FirebaseAuthGuard)
  sync(@CurrentIdentity() identity: VerifiedIdentity): Promise<ProfileResponse> {
    return this.users.syncFromIdentity(identity);
  }

  /** Called on every page load to restore the session. Login token only (no App Check, per the contract). */
  @Get('me')
  @Header('Cache-Control', NO_STORE)
  @UseGuards(FirebaseAuthGuard)
  me(@CurrentIdentity() identity: VerifiedIdentity): Promise<ProfileResponse> {
    return this.users.findOrCreateFromIdentity(identity);
  }
}
