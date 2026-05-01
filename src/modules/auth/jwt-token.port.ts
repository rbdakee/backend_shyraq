export interface IssueAccessPayload {
  sub: string;
  role: string;
  kindergarten_id?: string | null;
  pending_role_select?: boolean;
}

export interface IssueAccessResult {
  token: string;
  jti: string;
  expiresIn: number;
}

export interface DecodedAccessClaims {
  jti?: string;
  exp?: number;
}

/**
 * Full access-token payload returned by `verifyAccessToken`. Mirrors
 * `JwtPayload` from `src/common/types/jwt-payload.ts` but exists at the port
 * level so non-HTTP callers (the WS gateway in B9) can decode without
 * pulling in HTTP-specific guard plumbing.
 */
export interface VerifiedAccessClaims {
  sub: string;
  role: string;
  kindergarten_id?: string | null;
  pending_role_select?: boolean;
  jti?: string;
  iat?: number;
  exp?: number;
}

export abstract class JwtTokenPort {
  abstract issueAccessToken(
    payload: IssueAccessPayload,
  ): Promise<IssueAccessResult>;
  /**
   * Decode without signature verification. Used by /refresh and /logout paths
   * that want to blocklist a possibly-expired access token.
   */
  abstract decodeWithoutVerify(token: string): DecodedAccessClaims | null;
  /**
   * Verify the access-token signature + expiry. Used by `WsJwtGuard` /
   * `NotificationGateway.handleConnection` to authenticate the WS handshake
   * without depending on HTTP `JwtAuthGuard` plumbing. Throws on any failure
   * — caller is expected to translate into a domain/transport-specific error.
   */
  abstract verifyAccessToken(token: string): Promise<VerifiedAccessClaims>;
}
