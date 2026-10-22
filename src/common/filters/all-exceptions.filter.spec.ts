import { ArgumentsHost, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppException } from '../exceptions/app.exception.js';

function createHost(requestId: string | undefined) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status };
  const request = { requestId };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('maps an AppException to its own code, message, details, and the request id', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost('req-1');

    const exception = new AppException('SLOT_FULL', 'Slot is full', HttpStatus.CONFLICT, { slotId: 'abc' });
    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'SLOT_FULL',
        message: 'Slot is full',
        details: { slotId: 'abc' },
        requestId: 'req-1',
      },
    });
  });

  it('maps a generic HttpException (not AppException) to an INTERNAL code, preserving its status', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost('req-2');

    filter.catch(new NotFoundException('Cannot GET /nope'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL',
        message: 'Cannot GET /nope',
        details: {},
        requestId: 'req-2',
      },
    });
  });

  it.each([
    [HttpStatus.BAD_REQUEST, 'The request body could not be read'],
    [HttpStatus.PAYLOAD_TOO_LARGE, 'The request body is too large'],
  ])('maps the framework %i for an unreadable body to VALIDATION_FAILED in our own words', (code, message) => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost('req-3');

    filter.catch(new HttpException('Unexpected token } in JSON at position 17: {"email":"a@b.c"}', code), host);

    expect(status).toHaveBeenCalledWith(code);
    expect(json).toHaveBeenCalledWith({ error: { code: 'VALIDATION_FAILED', message, details: {}, requestId: 'req-3' } });
  });

  it('maps an unexpected non-HTTP error to a generic 500 INTERNAL without leaking its message', () => {
    const filter = new AllExceptionsFilter();
    const { host, status, json } = createHost('req-3');

    filter.catch(new Error('some internal implementation detail'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred',
        details: {},
        requestId: 'req-3',
      },
    });
  });

  it('falls back to "unknown" when no request id was attached', () => {
    const filter = new AllExceptionsFilter();
    const { host, json } = createHost(undefined);

    filter.catch(new Error('boom'), host);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ requestId: 'unknown' }) }));
  });
});
