import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
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
    FirebaseAuthGuard,
  ],
  exports: [IDENTITY_VERIFIER, FirebaseAuthGuard],
})
export class AuthModule {}
