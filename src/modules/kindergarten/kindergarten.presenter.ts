import { Kindergarten } from './domain/entities/kindergarten.entity';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { CreatedKindergartenWithAdmin } from './kindergarten.service';
import { KindergartenListResult } from './kindergarten.repository';
import {
  CreateKindergartenResponseDto,
  CreatedKindergartenStaffDto,
  CreatedKindergartenUserDto,
  KindergartenDto,
  KindergartenListResponseDto,
} from './dto/kindergarten-response.dto';

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
};
