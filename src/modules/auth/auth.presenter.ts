import {
  AuthResult,
  RoleView,
  SuperAdminAuthResult,
  UserSummaryView,
} from './auth-result.view';
import {
  AuthResponseDto,
  AuthUserResponseDto,
  KindergartenSummaryResponseDto,
  RoleResponseDto,
  SuperAdminAuthResponseDto,
} from './dto/auth-response.dto';

/**
 * Translates application-layer view objects (camelCase) into the snake_case
 * REST shape expected by clients. Kept as a stateless module so controllers
 * stay thin and unit tests can assert against domain shapes directly.
 */
export const AuthPresenter = {
  authResult(result: AuthResult): AuthResponseDto {
    const dto: AuthResponseDto = {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      pending_role_select: result.pendingRoleSelect,
      roles: result.roles.map(roleView),
      kindergartens: result.kindergartens.map(
        (k): KindergartenSummaryResponseDto => ({
          id: k.id,
          name: k.name,
          slug: k.slug,
        }),
      ),
      user: userSummary(result.user),
    };
    // Parent-app extras: only emit when the service populated them (app=parent).
    // Keeping them absent for /auth/refresh, /auth/role/select and super-admin
    // responses avoids leaking parent-only shape into staff/admin clients.
    if (result.isNewUser !== undefined) dto.is_new_user = result.isNewUser;
    if (result.profileComplete !== undefined)
      dto.profile_complete = result.profileComplete;
    if (result.parentContext !== undefined) {
      dto.parent_context = {
        approved_children_count: result.parentContext.approvedChildrenCount,
        pending_requests_count: result.parentContext.pendingRequestsCount,
      };
    }
    return dto;
  },
  superAdminAuthResult(
    result: SuperAdminAuthResult,
  ): SuperAdminAuthResponseDto {
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      pending_role_select: result.pendingRoleSelect,
      roles: result.roles.map(roleView),
    };
  },
};

function roleView(r: RoleView): RoleResponseDto {
  return {
    role: r.role,
    kindergarten_id: r.kindergartenId,
    group_id: r.groupId,
  };
}

function userSummary(u: UserSummaryView): AuthUserResponseDto {
  return {
    id: u.id,
    phone: u.phone,
    full_name: u.fullName,
    avatar_url: u.avatarUrl,
    iin: u.iin,
    date_of_birth:
      u.dateOfBirth !== null ? u.dateOfBirth.toISOString().slice(0, 10) : null,
    locale: u.locale,
  };
}
