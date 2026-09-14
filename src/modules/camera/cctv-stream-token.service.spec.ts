import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CctvStreamTokenService } from './cctv-stream-token.service';

const SECRET = 'a'.repeat(40);
const CAMERA = 'c1d2e3f4-3456-7890-cdef-3456789012cd';
const USER = 'u1d2e3f4-3456-7890-cdef-3456789012cd';

class MovableClock extends ClockPort {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

function build(
  secret: string | null = SECRET,
  ttlSeconds = 3600,
): { service: CctvStreamTokenService; clock: MovableClock } {
  const clock = new MovableClock(new Date('2026-09-14T12:00:00.000Z'));
  const config = new ConfigService({
    cctv: { streamTokenSecret: secret, streamTokenTtlSeconds: ttlSeconds },
  }) as ConfigService<AllConfigType>;
  return { service: new CctvStreamTokenService(config, clock), clock };
}

describe('CctvStreamTokenService', () => {
  it('returns the claims it signed', () => {
    const { service } = build();
    const minted = service.mint(CAMERA, USER);

    expect(service.verify(minted.token)).toEqual({
      cameraId: CAMERA,
      userId: USER,
      expiresAt: Math.floor(minted.expiresAt.getTime() / 1000),
    });
  });

  it('returns an expiry one TTL ahead of now', () => {
    const { service } = build(SECRET, 900);
    const minted = service.mint(CAMERA, USER);

    expect(minted.expiresAt).toEqual(new Date('2026-09-14T12:15:00.000Z'));
  });

  it('rejects a token once its lifetime has passed', () => {
    const { service, clock } = build(SECRET, 60);
    const minted = service.mint(CAMERA, USER);

    clock.advance(59);
    expect(service.verify(minted.token)).not.toBeNull();

    clock.advance(2);
    expect(service.verify(minted.token)).toBeNull();
  });

  it('rejects a token whose camera id was swapped', () => {
    const { service } = build();
    const minted = service.mint(CAMERA, USER);
    const other = 'ffffffff-3456-7890-cdef-3456789012cd';

    const tampered = minted.token.replace(CAMERA, other);

    expect(tampered).not.toBe(minted.token);
    expect(service.verify(tampered)).toBeNull();
  });

  it('rejects a token whose expiry was pushed out', () => {
    const { service } = build(SECRET, 60);
    const minted = service.mint(CAMERA, USER);
    const [v, cam, user, exp, sig] = minted.token.split('.');

    const tampered = [v, cam, user, String(Number(exp) + 86_400), sig].join(
      '.',
    );

    expect(service.verify(tampered)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const { service: mintedElsewhere } = build('b'.repeat(40));
    const { service } = build();

    const foreign = mintedElsewhere.mint(CAMERA, USER).token;

    expect(service.verify(foreign)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    const { service } = build();

    for (const bad of ['', 'nonsense', 'v1.only.three.parts', '....']) {
      expect(service.verify(bad)).toBeNull();
    }
    expect(service.verify(undefined)).toBeNull();
    expect(service.verify(null)).toBeNull();
  });

  it('reports itself unconfigured and verifies nothing without a key', () => {
    const { service } = build(null);

    expect(service.isConfigured).toBe(false);
    expect(service.verify('anything')).toBeNull();
  });
});
