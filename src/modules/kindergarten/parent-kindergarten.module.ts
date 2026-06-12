import { Module } from '@nestjs/common';
import { ChildModule } from '@/modules/child/child.module';
import { KindergartenModule } from './kindergarten.module';
import { ParentKindergartenController } from './parent-kindergarten.controller';

/**
 * Hosts the parent-facing kindergarten endpoint. Kept as a separate leaf
 * module (rather than adding the controller to `KindergartenModule`) so that
 * `KindergartenModule` does not have to import `ChildModule` — that would
 * close a Kindergarten → Child → Staff → Kindergarten cycle on top of the
 * existing Kindergarten ↔ Staff forwardRef. This mirrors how `parent-request`
 * / `pickup` / `billing` import both `ChildModule` and `KindergartenModule`
 * as downstream leaves.
 *
 *   - `ChildModule`        → exports `ChildGuardianRepository`, the dependency
 *     `ChildAccessGuard` resolves (the guard derives the tenant from the child).
 *   - `KindergartenModule` → exports `KindergartenService` for the lookup.
 */
@Module({
  imports: [ChildModule, KindergartenModule],
  controllers: [ParentKindergartenController],
})
export class ParentKindergartenModule {}
