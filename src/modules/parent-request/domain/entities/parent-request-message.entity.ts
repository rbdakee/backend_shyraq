export interface ParentRequestMessageState {
  id: string;
  kindergartenId: string;
  parentRequestId: string;
  authorUserId: string | null;
  authorStaffId: string | null;
  body: string;
  attachments: string[] | null;
  createdAt: Date;
}

/**
 * Immutable message in a parent-request thread.
 * Invariant: exactly one of (authorUserId, authorStaffId) must be non-null (XOR).
 */
export class ParentRequestMessage {
  private constructor(private readonly state: ParentRequestMessageState) {
    const userSet = state.authorUserId !== null;
    const staffSet = state.authorStaffId !== null;
    if (userSet === staffSet) {
      // Both null or both non-null violates XOR
      throw new Error('parent_request_message.author_xor_violation');
    }
  }

  static fromState(s: ParentRequestMessageState): ParentRequestMessage {
    return new ParentRequestMessage({ ...s });
  }

  toState(): ParentRequestMessageState {
    return { ...this.state };
  }

  // --- getters ---

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get parentRequestId(): string {
    return this.state.parentRequestId;
  }

  get authorUserId(): string | null {
    return this.state.authorUserId;
  }

  get authorStaffId(): string | null {
    return this.state.authorStaffId;
  }

  get body(): string {
    return this.state.body;
  }

  get attachments(): string[] | null {
    return this.state.attachments;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  // --- predicates ---

  isParentAuthored(): boolean {
    return this.state.authorUserId !== null;
  }

  isStaffAuthored(): boolean {
    return this.state.authorStaffId !== null;
  }
}
