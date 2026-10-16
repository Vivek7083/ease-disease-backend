import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Every domain error thrown in this app should be an AppException, so the response always
 * matches the locked error envelope in api-flow.md §3:
 *   { "error": { "code", "message", "details", "requestId" } }
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}
