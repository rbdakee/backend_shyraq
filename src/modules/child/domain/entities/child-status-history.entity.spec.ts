import { ChildStatusHistory } from './child-status-history.entity';
import { ChildStatusHistoryInvalidTransitionError } from '../errors/child-status-history-invalid-transition.error';
import { ChildStatusHistoryMissingArchiveReasonError } from '../errors/child-status-history-missing-archive-reason.error';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-05-13T03:30:00.000Z');

function baseInput() {
  return {
    id: 'history-1',
    kindergartenId: KG,
    childId: CHILD,
    previousStatus: 'active' as const,
    newStatus: 'archived' as const,
    previousArchiveReason: null,
    archiveReason: 'Перевод',
    changedByUserId: USER,
    changedAt: NOW,
  };
}

describe('ChildStatusHistory.record (T13 M1 — typed domain errors)', () => {
  it('returns a hydrated record for the active->archived transition with reason', () => {
    const r = ChildStatusHistory.record(baseInput());
    expect(r.previousStatus).toBe('active');
    expect(r.newStatus).toBe('archived');
    expect(r.archiveReason).toBe('Перевод');
  });

  it('returns a hydrated record for archived->active without archive_reason', () => {
    const r = ChildStatusHistory.record({
      ...baseInput(),
      previousStatus: 'archived',
      newStatus: 'active',
      previousArchiveReason: 'Перевод',
      archiveReason: null,
    });
    expect(r.previousStatus).toBe('archived');
    expect(r.newStatus).toBe('active');
    expect(r.archiveReason).toBeNull();
    expect(r.previousArchiveReason).toBe('Перевод');
  });

  it('returns a hydrated record for card_created->active without archive_reason', () => {
    const r = ChildStatusHistory.record({
      ...baseInput(),
      previousStatus: 'card_created',
      newStatus: 'active',
      archiveReason: null,
    });
    expect(r.previousStatus).toBe('card_created');
    expect(r.newStatus).toBe('active');
  });

  it('throws ChildStatusHistoryInvalidTransitionError for active->card_created', () => {
    expect(() =>
      ChildStatusHistory.record({
        ...baseInput(),
        previousStatus: 'active',
        newStatus: 'card_created',
        archiveReason: null,
      }),
    ).toThrow(ChildStatusHistoryInvalidTransitionError);
  });

  it('throws ChildStatusHistoryInvalidTransitionError for archived->card_created', () => {
    expect(() =>
      ChildStatusHistory.record({
        ...baseInput(),
        previousStatus: 'archived',
        newStatus: 'card_created',
        archiveReason: null,
      }),
    ).toThrow(ChildStatusHistoryInvalidTransitionError);
  });

  it('throws ChildStatusHistoryMissingArchiveReasonError when archived without a reason', () => {
    expect(() =>
      ChildStatusHistory.record({
        ...baseInput(),
        archiveReason: null,
      }),
    ).toThrow(ChildStatusHistoryMissingArchiveReasonError);
  });

  it('threw errors carry the canonical code so DomainErrorFilter maps to a typed 422', () => {
    try {
      ChildStatusHistory.record({
        ...baseInput(),
        previousStatus: 'active',
        newStatus: 'card_created',
        archiveReason: null,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChildStatusHistoryInvalidTransitionError);
      expect((err as ChildStatusHistoryInvalidTransitionError).code).toBe(
        'child_status_history_invalid_transition',
      );
    }

    try {
      ChildStatusHistory.record({ ...baseInput(), archiveReason: null });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ChildStatusHistoryMissingArchiveReasonError);
      expect((err as ChildStatusHistoryMissingArchiveReasonError).code).toBe(
        'child_status_history_missing_archive_reason',
      );
    }
  });
});
