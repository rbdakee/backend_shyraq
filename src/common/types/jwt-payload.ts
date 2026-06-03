/**
 * Decoded access-token claims passed to handlers via `req.user` and
 * `@CurrentUser()`. Mirrors `JsonwebtokenJwtAdapter.issueAccessToken`.
 */
export interface JwtPayload {
  sub: string;
  role: string;
  kindergarten_id?: string | null;
  pending_role_select?: boolean;
  /** App audience the session belongs to: 'parent' | 'staff' | 'admin'. */
  aud?: string;
  jti?: string;
  iat?: number;
  exp?: number;
}
