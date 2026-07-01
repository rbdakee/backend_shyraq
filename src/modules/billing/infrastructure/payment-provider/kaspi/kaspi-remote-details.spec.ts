import { parseRemoteDetails } from './kaspi-remote-details';

describe('parseRemoteDetails', () => {
  it('maps Processed to processed', () => {
    const r = parseRemoteDetails(200, { Data: { Status: 'Processed' } });
    expect(r.kind).toBe('processed');
    expect(r.rawStatus).toBe('Processed');
  });

  it('maps Processed case-insensitively', () => {
    const r = parseRemoteDetails(200, { Data: { Status: 'PROCESSED' } });
    expect(r.kind).toBe('processed');
  });

  it('maps RemotePaymentCreated to pending', () => {
    const r = parseRemoteDetails(200, {
      Data: { Status: 'RemotePaymentCreated' },
    });
    expect(r.kind).toBe('pending');
    expect(r.rawStatus).toBe('RemotePaymentCreated');
  });

  it('maps Wait / Created / New to pending', () => {
    for (const s of ['Wait', 'Created', 'New']) {
      expect(parseRemoteDetails(200, { Data: { Status: s } }).kind).toBe(
        'pending',
      );
    }
  });

  it('maps Canceled / Rejected / Expired / Error / Declined to terminal', () => {
    for (const s of [
      'Canceled',
      'Cancelled',
      'Rejected',
      'Expired',
      'Error',
      'Declined',
    ]) {
      const r = parseRemoteDetails(200, { Data: { Status: s } });
      expect(r.kind).toBe('terminal');
      expect(r.rawStatus).toBe(s);
    }
  });

  // #3 — Kaspi prefixes remote-flow statuses with `RemotePayment`. The live
  // 2026-06-20 pilot captured a customer-cancel as `RemotePaymentRejected`;
  // before the fix only the bare `Processed` mapped, so a cancelled payment
  // fell through to `pending` and polled forever instead of failing.
  it('maps RemotePaymentRejected (live customer-cancel) to terminal', () => {
    const r = parseRemoteDetails(200, {
      Data: { Status: 'RemotePaymentRejected' },
    });
    expect(r.kind).toBe('terminal');
    expect(r.rawStatus).toBe('RemotePaymentRejected');
  });

  it('maps the other RemotePayment-prefixed terminal forms to terminal', () => {
    for (const s of [
      'RemotePaymentCanceled',
      'RemotePaymentCancelled',
      'RemotePaymentExpired',
      'RemotePaymentDeclined',
      'RemotePaymentError',
      'RemotePaymentFailed',
    ]) {
      const r = parseRemoteDetails(200, { Data: { Status: s } });
      expect(r.kind).toBe('terminal');
      expect(r.rawStatus).toBe(s);
    }
  });

  it('maps RemotePaymentProcessed to processed', () => {
    const r = parseRemoteDetails(200, {
      Data: { Status: 'RemotePaymentProcessed' },
    });
    expect(r.kind).toBe('processed');
  });

  it('maps RemotePaymentWait / RemotePaymentNew to pending', () => {
    for (const s of ['RemotePaymentWait', 'RemotePaymentNew']) {
      expect(parseRemoteDetails(200, { Data: { Status: s } }).kind).toBe(
        'pending',
      );
    }
  });

  it('returns session_expired on httpStatus 401', () => {
    const r = parseRemoteDetails(401, { Data: { Status: 'Processed' } });
    expect(r.kind).toBe('session_expired');
  });

  it('returns session_expired on httpStatus 403', () => {
    const r = parseRemoteDetails(403, null);
    expect(r.kind).toBe('session_expired');
  });

  it('parses an ISO ExpireDate string', () => {
    const iso = '2026-06-04T19:00:00.000Z';
    const r = parseRemoteDetails(200, {
      Data: { Status: 'RemotePaymentCreated', ExpireDate: iso },
    });
    expect(r.expireDate?.toISOString()).toBe(iso);
  });

  it('parses an epoch-millis ExpireDate number', () => {
    const ms = Date.UTC(2026, 5, 4, 19, 0, 0);
    const r = parseRemoteDetails(200, {
      Data: { Status: 'Wait', ExpireDate: ms },
    });
    expect(r.expireDate?.getTime()).toBe(ms);
  });

  it('parses an epoch-seconds ExpireDate number', () => {
    const seconds = Math.floor(Date.UTC(2026, 5, 4, 19, 0, 0) / 1000);
    const r = parseRemoteDetails(200, {
      Data: { Status: 'Wait', ExpireDate: seconds },
    });
    expect(r.expireDate?.getTime()).toBe(seconds * 1000);
  });

  it('returns null expireDate for an unparseable ExpireDate', () => {
    const r = parseRemoteDetails(200, {
      Data: { Status: 'Wait', ExpireDate: 'not-a-date' },
    });
    expect(r.expireDate).toBeNull();
  });

  it('returns null expireDate when ExpireDate is absent', () => {
    const r = parseRemoteDetails(200, { Data: { Status: 'Wait' } });
    expect(r.expireDate).toBeNull();
  });

  it('treats a non-zero StatusCode + session error message as session_expired', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 5,
      Message: 'Token expired, re-authentication required',
    });
    expect(r.kind).toBe('session_expired');
  });

  it('treats a non-zero StatusCode + unauthor error code as session_expired', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 401,
      ErrorCode: 'UNAUTHORIZED_SESSION',
    });
    expect(r.kind).toBe('session_expired');
  });

  it('treats a non-zero StatusCode auth envelope as session_expired even when Data.Status is Error (before the terminal map)', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 1,
      ErrorCode: 'ExpiredToken',
      Data: { Status: 'Error' },
    });
    expect(r.kind).toBe('session_expired');
  });

  it('still maps a genuine terminal Canceled with StatusCode 0 to terminal', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 0,
      Data: { Status: 'Canceled' },
    });
    expect(r.kind).toBe('terminal');
    expect(r.rawStatus).toBe('Canceled');
  });

  it('does not treat a zero StatusCode as session_expired', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 0,
      Data: { Status: 'Wait' },
    });
    expect(r.kind).toBe('pending');
  });

  it('does not treat a non-session error message as session_expired', () => {
    const r = parseRemoteDetails(200, {
      StatusCode: 5,
      Message: 'Insufficient funds',
    });
    // No recognised status, no session pattern → safe pending.
    expect(r.kind).toBe('pending');
  });

  it('returns pending for an unknown status with no error', () => {
    const r = parseRemoteDetails(200, {
      Data: { Status: 'SomethingNew' },
    });
    expect(r.kind).toBe('pending');
    expect(r.rawStatus).toBe('SomethingNew');
  });

  it('returns pending for a missing status with no error', () => {
    const r = parseRemoteDetails(200, { Data: {} });
    expect(r.kind).toBe('pending');
    expect(r.rawStatus).toBeNull();
  });

  it('returns pending for a null body', () => {
    const r = parseRemoteDetails(200, null);
    expect(r.kind).toBe('pending');
    expect(r.rawStatus).toBeNull();
    expect(r.expireDate).toBeNull();
  });
});
