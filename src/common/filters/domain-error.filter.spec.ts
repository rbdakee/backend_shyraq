import { ArgumentsHost, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DomainErrorFilter } from './domain-error.filter';

function makeHost() {
  const res = {
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { res, host };
}

function pgError(code: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT ...',
    [],
    Object.assign(new Error('pg'), { code }),
  );
}

describe('DomainErrorFilter — errors it does not know', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  it('answers a plain Error with a JSON 500 instead of rethrowing', () => {
    const { res, host } = makeHost();
    expect(() =>
      new DomainErrorFilter().catch(new Error('boom'), host),
    ).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 500,
      error: 'server_error',
      message: 'server_error',
    });
  });

  it('maps a Postgres unique violation to 409 unique_violation', () => {
    const { res, host } = makeHost();
    new DomainErrorFilter().catch(pgError('23505'), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'unique_violation' }),
    );
  });

  it('maps a Postgres foreign key violation to 409 foreign_key_violation', () => {
    const { res, host } = makeHost();
    new DomainErrorFilter().catch(pgError('23503'), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'foreign_key_violation' }),
    );
  });

  it('does not write to a response that already started streaming', () => {
    const { res, host } = makeHost();
    res.headersSent = true;
    new DomainErrorFilter().catch(new Error('mid-stream'), host);
    expect(res.status).not.toHaveBeenCalled();
  });
});
