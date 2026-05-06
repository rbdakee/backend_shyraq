import {
  ParentRequestMessage,
  ParentRequestMessageState,
} from '../../../../domain/entities/parent-request-message.entity';
import { ParentRequestMessageTypeOrmEntity } from '../entities/parent-request-message.typeorm.entity';

/**
 * Domain ↔ persistence mapper for the ParentRequestMessage value object.
 * Lives in the relational subtree because it knows the TypeORM entity shape.
 */
export class ParentRequestMessageMapper {
  static toDomain(
    row: ParentRequestMessageTypeOrmEntity,
  ): ParentRequestMessage {
    const state: ParentRequestMessageState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      parentRequestId: row.parentRequestId,
      authorUserId: row.authorUserId,
      authorStaffId: row.authorStaffId,
      body: row.body,
      attachments: row.attachments,
      createdAt: row.createdAt,
    };
    return ParentRequestMessage.fromState(state);
  }
}
