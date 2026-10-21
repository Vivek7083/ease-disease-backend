import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { AppCheckGuard } from './app-check.guard.js';
import { APP_CHECK_VERIFIER, type AppCheckVerifier } from './app-check-verifier.js';
import { FirebaseAppCheckVerifier, UnconfiguredAppCheckVerifier } from './firebase-app-check-verifier.js';
import { FirebaseAuthGuard } from './firebase-auth.guard.js';
import { FirebaseIdentityVerifier, UnconfiguredIdentityVerifier } from './firebase-identity-verifier.js';
import { IDENTITY_VERIFIER, type IdentityVerifier } from './identity-verifier.js';

@Module({
  providers: [
    {
      provide: IDENTITY_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): IdentityVerifier => {
        const projectId = config.get('FIREBASE_PROJECT_ID', { infer: true });
        return projectId ? new FirebaseIdentityVerifier({ projectId }) : new UnconfiguredIdentityVerifier();
      },
    },
    {
      provide: APP_CHECK_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AppCheckVerifier => {
        const projectId = config.get('FIREBASE_PROJECT_ID', { infer: true });
        return projectId ? new FirebaseAppCheckVerifier({ projectId }) : new UnconfiguredAppCheckVerifier();
      },
    },
    FirebaseAuthGuard,
    AppCheckGuard,
  ],
  exports: [IDENTITY_VERIFIER, APP_CHECK_VERIFIER, FirebaseAuthGuard, AppCheckGuard],
})
export class AuthModule implements OnModuleInit {
  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit(): void {
    if (this.config.get('APP_CHECK_MODE', { infer: true }) === 'off') {
      new Logger(AuthModule.name).warn('APP_CHECK_MODE=off: App Check is NOT being enforced (development/test only)');
    }
  }
}
