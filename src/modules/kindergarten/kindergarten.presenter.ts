import { Kindergarten } from './domain/entities/kindergarten.entity';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  AddedAdmin,
  CreatedKindergartenWithAdmin,
  KindergartenAdminRow,
} from './kindergarten.service';
import { KindergartenListResult } from './infrastructure/persistence/kindergarten.repository';
import {
  AddKindergartenAdminResponseDto,
  CreateKindergartenResponseDto,
  CreatedKindergartenStaffDto,
  CreatedKindergartenUserDto,
  KindergartenAdminDto,
  KindergartenDto,
  KindergartenListResponseDto,
} from './dto/kindergarten-response.dto';
import { ParentKindergartenDto } from './dto/parent-kindergarten-response.dto';

export const KindergartenPresenter = {
  kindergarten(kg: Kindergarten): KindergartenDto {
    const s = kg.toState();
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      address: s.address,
      phone: s.phone,
      plan: s.plan,
      settings: s.settings,
      is_active: s.isActive,
      archived_at: s.archivedAt !== null ? s.archivedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  /**
   * Parent-facing projection — only the public identity fields. Keeps the
   * internal `settings` / `plan` / `slug` / lifecycle flags out of the parent
   * app response. See `ParentKindergartenDto`.
   */
  parent(kg: Kindergarten): ParentKindergartenDto {
    const s = kg.toState();
    return {
      id: s.id,
      name: s.name,
      address: s.address,
      phone: s.phone,
    };
  },

  list(result: KindergartenListResult): KindergartenListResponseDto {
    return {
      items: result.items.map((kg) => KindergartenPresenter.kindergarten(kg)),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  },

  staffMember(s: StaffMember): CreatedKindergartenStaffDto {
    const state = s.toState();
    return {
      id: state.id,
      kindergarten_id: state.kindergartenId,
      user_id: state.userId,
      role: state.role as 'admin',
      is_active: state.isActive,
      hired_at:
        state.hiredAt !== null
          ? state.hiredAt.toISOString().slice(0, 10)
          : null,
    };
  },

  createdWithAdmin(
    created: CreatedKindergartenWithAdmin,
  ): CreateKindergartenResponseDto {
    return {
      kindergarten: KindergartenPresenter.kindergarten(created.kindergarten),
      staff_member: KindergartenPresenter.staffMember(created.staffMember),
      user: KindergartenPresenter.user(created.user),
    };
  },

  user(u: CreatedKindergartenWithAdmin['user']): CreatedKindergartenUserDto {
    return {
      id: u.id,
      phone: u.phone,
      full_name: u.fullName,
      locale: u.locale,
    };
  },

  adminRow(row: KindergartenAdminRow): KindergartenAdminDto {
    return {
      staff_member_id: row.staffMemberId,
      user_id: row.userId,
      full_name: row.fullName,
      phone: row.phone,
      locale: row.locale,
      is_active: row.isActive,
      hired_at:
        row.hiredAt !== null ? row.hiredAt.toISOString().slice(0, 10) : null,
      fired_at:
        row.firedAt !== null ? row.firedAt.toISOString().slice(0, 10) : null,
      created_at: row.createdAt.toISOString(),
    };
  },

  adminList(rows: KindergartenAdminRow[]): KindergartenAdminDto[] {
    return rows.map((r) => KindergartenPresenter.adminRow(r));
  },

  addedAdmin(added: AddedAdmin): AddKindergartenAdminResponseDto {
    const s = added.staffMember.toState();
    return {
      kindergarten_id: added.kindergartenId,
      user: {
        id: added.user.id,
        phone: added.user.phone,
        full_name: added.user.fullName,
        locale: added.user.locale,
      },
      staff_member: {
        id: s.id,
        role: s.role as 'admin',
        is_active: s.isActive,
        hired_at:
          s.hiredAt !== null ? s.hiredAt.toISOString().slice(0, 10) : null,
        created_at: s.createdAt.toISOString(),
      },
      invite_sms_sent: added.inviteSmsSent,
    };
  },
};
