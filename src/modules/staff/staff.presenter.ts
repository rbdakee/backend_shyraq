import { StaffMember } from './domain/entities/staff-member.entity';
import { StaffMemberDto } from './dto/staff-response.dto';

export class StaffPresenter {
  static staff(
    member: StaffMember,
    identity?: { fullName: string | null; phone: string | null },
  ): StaffMemberDto {
    const s = member.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      user_id: s.userId,
      full_name: identity?.fullName ?? s.fullName,
      phone: identity?.phone ?? s.phone,
      role: s.role,
      specialist_type: s.specialistType,
      is_active: s.isActive,
      hired_at: s.hiredAt ? s.hiredAt.toISOString().slice(0, 10) : null,
      fired_at: s.firedAt ? s.firedAt.toISOString().slice(0, 10) : null,
      archived_at: s.archivedAt ? s.archivedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  }
}
