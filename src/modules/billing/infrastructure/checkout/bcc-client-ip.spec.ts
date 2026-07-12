import { resolveBccClientIp } from './bcc-client-ip';

function request(remoteAddress: string, forwarded?: string) {
  return {
    socket: { remoteAddress },
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  };
}

describe('resolveBccClientIp', () => {
  it('uses the socket peer when no trusted proxy is configured', () => {
    expect(resolveBccClientIp(request('::ffff:127.0.0.1') as never, 0)).toBe(
      '127.0.0.1',
    );
  });

  it('uses the address before one explicitly trusted proxy', () => {
    expect(
      resolveBccClientIp(request('127.0.0.1', '203.0.113.10') as never, 1),
    ).toBe('203.0.113.10');
  });

  it('does not trust a spoofed forwarded address by default', () => {
    expect(
      resolveBccClientIp(
        request('10.0.0.5', '198.51.100.20, 203.0.113.1') as never,
        0,
      ),
    ).toBe('10.0.0.5');
  });
});
