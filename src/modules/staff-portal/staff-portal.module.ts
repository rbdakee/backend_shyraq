import { Module } from '@nestjs/common';
import { AttendanceModule } from '@/modules/attendance/attendance.module';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { LocationModule } from '@/modules/location/location.module';
import { StaffGroupsController } from './staff-groups.controller';
import { StaffChildController } from './staff-child.controller';
import { StaffPortalService } from './staff-portal.service';

/**
 * StaffPortalModule — read-only Staff-App composition layer. Owns no table, no
 * migration, no domain entity (a LEAF module — nothing imports it, so importing
 * the feature modules below introduces no cycle). Mirrors DashboardModule.
 *
 * It composes already-exported bounded-context ports/services:
 *   - GroupModule      → GroupRepository (assignments, group lookup)
 *   - ChildModule      → ChildRepository (list/count) + ChildService (child
 *                        card + group-name / guardian-identity overlays)
 *   - AttendanceModule → ChildDailyStatusRepository (today's day_status overlay)
 *   - LocationModule   → LocationRepository (group room name)
 *
 * StaffModule / UsersModule are intentionally NOT imported: guardian identity
 * (full_name / phone) is resolved via `ChildService.resolveGuardianIdentities`,
 * which already owns the `users` lookup inside ChildModule — so this leaf module
 * needs no direct UserRepository / StaffMemberRepository dependency.
 *
 * ClockPort is provided globally by SharedKernelModule (@Global). No
 * `TypeOrmModule.forFeature` and no port `{ provide, useClass }` is declared —
 * the relational impls come from the imported modules; this module never
 * touches TypeORM directly.
 */
@Module({
  imports: [ChildModule, GroupModule, AttendanceModule, LocationModule],
  controllers: [StaffGroupsController, StaffChildController],
  providers: [StaffPortalService],
})
export class StaffPortalModule {}
