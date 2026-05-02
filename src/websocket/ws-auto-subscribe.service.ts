import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { VerifiedAccessClaims } from '@/modules/auth/jwt-token.port';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';

/**
 * Roles considered staff-side for the purposes of room subscription. A
 * staff-shaped JWT joins `group:*` rooms; a parent-shaped JWT joins
 * `child:*` rooms. Mixed accounts (one user has both staff_members and
 * child_guardians rows) get only ONE side per connection, picked by the
 * JWT's `role` claim — re-handshake required to switch context.
 */
const STAFF_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'staff',
  'mentor',
  'manager',
  'methodist',
  'medic',
  'cook',
  'driver',
  'security',
]);

const PARENT_ROLES: ReadonlySet<string> = new Set(['parent']);

const SUPER_ADMIN_ROLES: ReadonlySet<string> = new Set(['super_admin']);

/**
 * WsAutoSubscribeService — joins a freshly-authenticated socket to the room
 * set that exactly matches the JWT's `role` + `kindergarten_id` at the
 * moment of the handshake.
 *
 * Contract (see `architecture.md §6.4`, `endpoints.md §0.6`):
 *   - `user:{userId}` — always.
 *   - `child:{childId}` — only when role ∈ PARENT_ROLES AND the JWT carries
 *     a non-null `kindergarten_id`. Cross-tenant guardian links of the
 *     same user in OTHER kindergartens are intentionally excluded —
 *     receiving those would leak events from a kg the current handshake
 *     is not scoped to.
 *   - `group:{groupId}` — only when role ∈ STAFF_ROLES AND the JWT carries
 *     a non-null `kindergarten_id`. Active mentor assignments in OTHER
 *     kindergartens are excluded for the same reason.
 *   - `super_admin` — empty room set beyond `user:{id}`. Admin UIs typically
 *     poll; targeted notifications can be added under a dedicated
 *     `admin:*` room when the use case appears.
 *   - `pending_role_select=true` or null `kindergarten_id` — only
 *     `user:{id}`. The user has not picked a tenant context yet, so no
 *     kg-scoped rooms apply.
 *
 * If the operating user changes role or switches kg they must re-handshake
 * with a fresh JWT; the gateway never silently widens the room set after
 * the initial join.
 */
@Injectable()
export class WsAutoSubscribeService {
  private readonly logger = new Logger(WsAutoSubscribeService.name);

  constructor(
    private readonly guardianRepo: ChildGuardianRepository,
    private readonly groupRepo: GroupRepository,
  ) {}

  /**
   * Join `socket` to all rooms it should receive events for, derived from
   * `claims.role` + `claims.kindergarten_id`. Returns the resolved room
   * list so the gateway can echo it back via the `connected` event for
   * client-side confirmation.
   *
   * Pre-conditions:
   *   - `claims.sub` is the authenticated user id (handshake JWT was
   *     already verified by the gateway).
   *
   * Post-conditions:
   *   - `socket` has joined every room in the returned `rooms` array.
   *   - The room set is a strict subset of what the JWT authorises.
   */
  async subscribe(
    socket: Socket,
    claims: VerifiedAccessClaims,
  ): Promise<{ rooms: string[] }> {
    const userId = claims.sub;
    const role = claims.role;
    const kgId = claims.kindergarten_id ?? null;
    const pending = claims.pending_role_select === true;

    const rooms: string[] = [`user:${userId}`];

    // Super-admin: no targeted notifications today. Empty room set
    // beyond user:{id} keeps the contract simple and avoids accidental
    // cross-tenant leakage if a super-admin happens to also be a
    // guardian/mentor somewhere.
    if (SUPER_ADMIN_ROLES.has(role)) {
      await this.joinAll(socket, rooms);
      this.logSubscribed(socket, claims, rooms);
      return { rooms };
    }

    // Pending role-select / no kg context yet: subscribe only to the
    // user-scoped room. Once the user picks a tenant a fresh JWT will
    // re-handshake and pick up the role-specific rooms.
    if (pending || !kgId) {
      await this.joinAll(socket, rooms);
      this.logSubscribed(socket, claims, rooms);
      return { rooms };
    }

    if (PARENT_ROLES.has(role)) {
      const guardianRows =
        await this.guardianRepo.findApprovedActiveByUserIdCrossTenant(
          userId,
          kgId,
        );
      const seen = new Set<string>();
      for (const g of guardianRows) {
        const cid = g.toState().childId;
        if (seen.has(cid)) continue;
        seen.add(cid);
        rooms.push(`child:${cid}`);
      }
    } else if (STAFF_ROLES.has(role)) {
      const mentorRows =
        await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
          userId,
          kgId,
        );
      const seen = new Set<string>();
      for (const m of mentorRows) {
        const gid = m.toState().groupId;
        if (seen.has(gid)) continue;
        seen.add(gid);
        rooms.push(`group:${gid}`);
      }
    }
    // Any other role (future / unknown): only user:{id} — fail closed.

    await this.joinAll(socket, rooms);
    this.logSubscribed(socket, claims, rooms);
    return { rooms };
  }

  private async joinAll(socket: Socket, rooms: string[]): Promise<void> {
    for (const room of rooms) {
      await socket.join(room);
    }
  }

  private logSubscribed(
    socket: Socket,
    claims: VerifiedAccessClaims,
    rooms: string[],
  ): void {
    this.logger.debug(
      `socket=${socket.id} user=${claims.sub} role=${claims.role} kg=${claims.kindergarten_id ?? '<none>'} joined ${rooms.length} room(s)`,
    );
  }
}
