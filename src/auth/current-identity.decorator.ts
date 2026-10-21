import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception.js';
import type { AuthenticatedRequest } from './firebase-auth.guard.js';
import type { VerifiedIdentity } from './identity-verifier.js';

/**
 * The verified caller. Only available behind `FirebaseAuthGuard`; if a route forgets the guard this refuses with the
 * same 401 instead of handing the handler an undefined identity.
 */
export const CurrentIdentity = createParamDecorator((_data: unknown, context: ExecutionContext): VerifiedIdentity => {
  const identity = context.switchToHttp().getRequest<AuthenticatedRequest>().identity;
  if (!identity) throw new AppException('UNAUTHENTICATED', 'Authentication required', 401);
  return identity;
});
