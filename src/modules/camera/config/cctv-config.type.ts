export type MediaGatewayProvider = 'mock' | 'go2rtc';

export interface Go2rtcConfig {
  /** Base URL of the go2rtc API, e.g. `http://127.0.0.1:1984`. No trailing slash. */
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface CctvConfig {
  mediaGateway: MediaGatewayProvider;
  /** Null unless `mediaGateway === 'go2rtc'`. */
  go2rtc: Go2rtcConfig | null;
  /**
   * Public origin that serves streams to the apps, e.g.
   * `https://balam-stream.innodev.kz`. Null until the TLS host exists; the
   * parent API refuses to hand out stream URLs while it is null rather than
   * emitting links to an origin nobody can reach.
   */
  streamPublicBase: string | null;
  /** `false` disables the periodic codec probe (single-node dev, tests). */
  codecProbeEnabled: boolean;
  /**
   * HMAC key for stream tokens. Null disables parent streaming entirely —
   * the endpoints answer 503 rather than minting tokens nobody can verify.
   * Separate from AUTH_JWT_SECRET on purpose: these tokens travel in URLs
   * and end up in proxy logs, so they must not share a key with session JWTs.
   */
  streamTokenSecret: string | null;
  /** Lifetime of a stream token. Short enough that a revoked guardian loses
   *  access quickly, long enough to watch without re-fetching constantly. */
  streamTokenTtlSeconds: number;
}
