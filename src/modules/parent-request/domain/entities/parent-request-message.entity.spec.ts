import {
  ParentRequestMessage,
  ParentRequestMessageState,
} from './parent-request-message.entity';

const NOW = new Date('2026-05-06T10:00:00Z');

function baseState(
  overrides: Partial<ParentRequestMessageState> = {},
): ParentRequestMessageState {
  return {
    id: 'msg-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    parentRequestId: 'req-uuid-0001',
    authorUserId: null,
    authorStaffId: null,
    body: 'Hello',
    attachments: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('ParentRequestMessage domain entity', () => {
  // ── XOR author invariant ─────────────────────────────────────────────────

  it('creates successfully with authorUserId set and authorStaffId null', () => {
    const msg = ParentRequestMessage.fromState(
      baseState({ authorUserId: 'user-uuid-0001', authorStaffId: null }),
    );
    expect(msg.authorUserId).toBe('user-uuid-0001');
    expect(msg.authorStaffId).toBeNull();
    expect(msg.isParentAuthored()).toBe(true);
    expect(msg.isStaffAuthored()).toBe(false);
  });

  it('creates successfully with authorStaffId set and authorUserId null', () => {
    const msg = ParentRequestMessage.fromState(
      baseState({ authorUserId: null, authorStaffId: 'staff-uuid-0001' }),
    );
    expect(msg.authorStaffId).toBe('staff-uuid-0001');
    expect(msg.authorUserId).toBeNull();
    expect(msg.isStaffAuthored()).toBe(true);
    expect(msg.isParentAuthored()).toBe(false);
  });

  it('throws when both authorUserId and authorStaffId are set', () => {
    expect(() =>
      ParentRequestMessage.fromState(
        baseState({
          authorUserId: 'user-uuid-0001',
          authorStaffId: 'staff-uuid-0001',
        }),
      ),
    ).toThrow('parent_request_message.author_xor_violation');
  });

  it('throws when both authorUserId and authorStaffId are null', () => {
    expect(() =>
      ParentRequestMessage.fromState(
        baseState({ authorUserId: null, authorStaffId: null }),
      ),
    ).toThrow('parent_request_message.author_xor_violation');
  });

  // ── getters and toState round-trip ────────────────────────────────────────

  it('exposes correct getters for a parent-authored message', () => {
    const state = baseState({
      authorUserId: 'user-uuid-0002',
      authorStaffId: null,
      body: 'Please accept my day-off request',
      attachments: ['https://cdn.example.com/doc.pdf'],
    });
    const msg = ParentRequestMessage.fromState(state);
    expect(msg.id).toBe(state.id);
    expect(msg.kindergartenId).toBe(state.kindergartenId);
    expect(msg.parentRequestId).toBe(state.parentRequestId);
    expect(msg.body).toBe(state.body);
    expect(msg.attachments).toEqual(['https://cdn.example.com/doc.pdf']);
    expect(msg.createdAt).toBe(state.createdAt);
  });

  it('round-trips state correctly through fromState and toState', () => {
    const state = baseState({
      authorUserId: 'user-uuid-0003',
      authorStaffId: null,
      body: 'My vacation request',
      attachments: null,
    });
    const msg = ParentRequestMessage.fromState(state);
    expect(msg.toState()).toEqual(state);
  });
});
