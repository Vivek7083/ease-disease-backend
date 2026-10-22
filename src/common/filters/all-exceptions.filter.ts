import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * Maps every thrown error to the locked envelope from api-flow.md §3. Anything that isn't an
 * AppException (a bug, a library throwing HttpException directly, an unexpected error) becomes
 * a generic INTERNAL so callers never see a bare stack trace or an unmapped shape.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId ?? 'unknown';

    const { status, body } = this.toErrorBody(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`[${requestId}] ${body.error.code}: ${body.error.message}`, (exception as Error)?.stack);
    }

    response.status(status).json(body);
  }

  private toErrorBody(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details ?? {},
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // The framework answers an unreadable body (malformed JSON, a bare string or null where an object is expected, too
      // large) with a bare 400 / 413 before any handler runs. The UI branches on `code`, and the parser's own message can
      // quote part of the body, so say it in our words.
      if (status === HttpStatus.BAD_REQUEST || status === HttpStatus.PAYLOAD_TOO_LARGE) {
        const message = status === HttpStatus.BAD_REQUEST ? 'The request body could not be read' : 'The request body is too large';
        return { status, body: { error: { code: 'VALIDATION_FAILED', message, details: {}, requestId } } };
      }
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: 'INTERNAL',
            message: exception.message,
            details: {},
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL',
          message: 'An unexpected error occurred',
          details: {},
          requestId,
        },
      },
    };
  }
}
