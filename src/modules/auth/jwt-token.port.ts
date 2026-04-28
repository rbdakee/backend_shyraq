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

export abstract class JwtTokenPort {
  abstract issueAccessToken(
    payload: IssueAccessPayload,
  ): Promise<IssueAccessResult>;
  /**
   * Decode without signature verification. Used by /refresh and /logout paths
   * that want to blocklist a possibly-expired access token.
   */
  abstract decodeWithoutVerify(token: string): DecodedAccessClaims | null;
}
