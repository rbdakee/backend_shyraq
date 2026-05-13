import { NotFoundError } from '@/shared-kernel/domain/errors';
import { UserNotFoundError } from './user-not-found.error';

describe('UserNotFoundError', () => {
  it('defaults code to user_not_found', () => {
    const err = new UserNotFoundError('user-1');
    expect(err.code).toBe('user_not_found');
    expect(err.message).toBe('user not found: user-1');
  });

  it('remains an instance of NotFoundError for the DomainErrorFilter 404 branch', () => {
    const err = new UserNotFoundError('user-1');
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('honours codeOverride so auth flows can mask as invalid_credentials', () => {
    // BP §3.1 — login + password-reset + refresh must return a uniform
    // error code so the HTTP response cannot be used to enumerate which
    // user-ids exist. The override keeps a single throw-site while
    // letting the caller explicitly opt into masking.
    const err = new UserNotFoundError('user-1', {
      codeOverride: 'invalid_credentials',
    });
    expect(err.code).toBe('invalid_credentials');
    // The underlying entity/id is still rendered in `message` (debug
    // logs); only `code` is masked.
    expect(err.message).toBe('user not found: user-1');
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('codeOverride is final — defineProperty makes it non-writable', () => {
    const err = new UserNotFoundError('user-1', {
      codeOverride: 'invalid_credentials',
    });
    expect(() => {
      // Strict mode would throw; in non-strict it's silently ignored.
      // Either way the value must not change.
      (err as { code: string }).code = 'tampered';
    }).toThrow();
    expect(err.code).toBe('invalid_credentials');
  });
});
