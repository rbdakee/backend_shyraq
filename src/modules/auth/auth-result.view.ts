/**
 * Service-layer view types for /auth responses. Controllers shape these into
 * snake_case DTOs; tests assert against these structures.
 */
export interface RoleView {
  role: string;
  kindergartenId: string | null;
  groupId: string | null;
  /**
   * Raw specialist-type enum (psychologist | speech_therapist | music_teacher
   * | physical_ed | nutritionist). Non-null ONLY for `role === 'specialist'`;
   * null for every other role (admin/mentor/reception/parent/super-admin).
   * Required field so the compiler flags any role literal that forgets it.
   */
  specialistType: string | null;
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

export interface ParentContextView {
  approvedChildrenCount: number;
  pendingRequestsCount: number;
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
  /** Parent-app-only extras — present only when app=parent, omitted otherwise. */
  isNewUser?: boolean;
  profileComplete?: boolean;
  parentContext?: ParentContextView;
}

export interface SuperAdminAuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  pendingRoleSelect: false;
  roles: RoleView[];
}
