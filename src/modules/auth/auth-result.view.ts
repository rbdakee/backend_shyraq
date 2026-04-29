/**
 * Service-layer view types for /auth responses. Controllers shape these into
 * snake_case DTOs; tests assert against these structures.
 */
export interface RoleView {
  role: string;
  kindergartenId: string | null;
  groupId: string | null;
}

export interface KindergartenSummaryView {
  id: string;
  name: string;
  slug: string;
}

export interface UserSummaryView {
  id: string;
  phone: string;
  fullName: string;
  avatarUrl: string | null;
  iin: string | null;
  dateOfBirth: Date | null;
  locale: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string | null;
  tokenType: 'Bearer';
  expiresIn: number;
  pendingRoleSelect: boolean;
  roles: RoleView[];
  kindergartens: KindergartenSummaryView[];
  user: UserSummaryView;
}

export interface SuperAdminAuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  pendingRoleSelect: false;
  roles: RoleView[];
}
