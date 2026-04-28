export abstract class TokenBlocklistPort {
  abstract isBlocked(jti: string): Promise<boolean>;
  /** expUnix is seconds-since-epoch — TTL is computed as (expUnix - now). */
  abstract blocklist(jti: string, expUnix: number): Promise<void>;
}
