import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';

/**
 * WsAutoSubscribeService — joins a freshly-authenticated socket to all rooms
 * it should receive events for.
 *
 * Three room kinds (matches `architecture.md §6.4`, `endpoints.md §0.6`):
 *   - `user:{userId}`  — always.
 *   - `child:{childId}` — for every approved + non-revoked guardian-child
 *     link the user has across all kindergartens.
 *   - `group:{groupId}` — for every currently-active mentor assignment the
 *     user has (resolved via `staff_members.user_id` join).
 *
 * Both lookups bypass RLS (the user can be a guardian / mentor across
 * multiple kindergartens). Returning the full room list lets the client
 * verify auto-subscribe completed (emitted as the `connected` event).
 */
@Injectable()
export class WsAutoSubscribeService {
  private readonly logger = new Logger(WsAutoSubscribeService.name);

  constructor(
    private readonly guardianRepo: ChildGuardianRepository,
    private readonly groupRepo: GroupRepository,
  ) {}

  async subscribe(
    socket: Socket,
    userId: string,
  ): Promise<{ rooms: string[] }> {
    const rooms: string[] = [`user:${userId}`];

    const [guardianRows, mentorRows] = await Promise.all([
      this.guardianRepo.findApprovedActiveByUserIdCrossTenant(userId),
      this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(userId),
    ]);

    const seenChildren = new Set<string>();
    for (const g of guardianRows) {
      const cid = g.toState().childId;
      if (seenChildren.has(cid)) continue;
      seenChildren.add(cid);
      rooms.push(`child:${cid}`);
    }

    const seenGroups = new Set<string>();
    for (const m of mentorRows) {
      const gid = m.toState().groupId;
      if (seenGroups.has(gid)) continue;
      seenGroups.add(gid);
      rooms.push(`group:${gid}`);
    }

    for (const room of rooms) {
      await socket.join(room);
    }

    this.logger.debug(
      `socket=${socket.id} user=${userId} joined ${rooms.length} room(s)`,
    );
    return { rooms };
  }
}
