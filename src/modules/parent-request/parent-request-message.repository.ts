import { ParentRequestMessage } from './domain/entities/parent-request-message.entity';

export interface CreateParentRequestMessageInput {
  kindergartenId: string;
  parentRequestId: string;
  authorUserId: string | null;
  authorStaffId: string | null;
  body: string;
  attachments: string[] | null;
}

export abstract class ParentRequestMessageRepository {
  abstract create(
    input: CreateParentRequestMessageInput,
  ): Promise<ParentRequestMessage>;
  abstract listByRequestId(
    parentRequestId: string,
    kindergartenId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ParentRequestMessage[]>;
}
