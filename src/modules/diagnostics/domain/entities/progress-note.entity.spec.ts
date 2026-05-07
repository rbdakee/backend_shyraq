import { ProgressNote, ProgressNoteState } from './progress-note.entity';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ProgressNoteNotAuthoredByYouError } from '../errors/progress-note-not-authored-by-you.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const FOUR_MIN_LATER = new Date(NOW.getTime() + 4 * 60 * 1000);
const SIX_MIN_LATER = new Date(NOW.getTime() + 6 * 60 * 1000);

function makeState(
  overrides: Partial<ProgressNoteState> = {},
): ProgressNoteState {
  return {
    id: 'note-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    mentorId: 'staff-uuid-0001',
    body: 'Made good eye contact during morning circle.',
    mediaUrls: [],
    notedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe('ProgressNote domain entity', () => {
  it('constructs with valid state (happy path)', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    expect(n.body).toMatch(/eye contact/);
    expect(n.mediaUrls).toEqual([]);
  });

  it('throws when body is empty', () => {
    expect(() => ProgressNote.fromState(makeState({ body: '' }), NOW)).toThrow(
      InvariantViolationError,
    );
  });

  it('throws when body is whitespace only', () => {
    expect(() =>
      ProgressNote.fromState(makeState({ body: '   \t\n' }), NOW),
    ).toThrow(/empty_body/);
  });

  it('accepts notedAt = now', () => {
    expect(() =>
      ProgressNote.fromState(makeState({ notedAt: NOW }), NOW),
    ).not.toThrow();
  });

  it('accepts notedAt = now + 4 minutes (within skew)', () => {
    expect(() =>
      ProgressNote.fromState(makeState({ notedAt: FOUR_MIN_LATER }), NOW),
    ).not.toThrow();
  });

  it('throws when notedAt = now + 6 minutes (beyond skew)', () => {
    expect(() =>
      ProgressNote.fromState(makeState({ notedAt: SIX_MIN_LATER }), NOW),
    ).toThrow(/noted_at_in_future/);
  });

  it('defaults mediaUrls to [] when not provided', () => {
    const n = ProgressNote.fromState(
      makeState({ mediaUrls: undefined as unknown as string[] }),
      NOW,
    );
    expect(n.mediaUrls).toEqual([]);
  });

  it('update body to a new non-empty string succeeds', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    const next = n.update({ body: 'Updated note text' }, NOW);
    expect(next.body).toBe('Updated note text');
  });

  it('update body to empty throws', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    expect(() => n.update({ body: '' }, NOW)).toThrow(InvariantViolationError);
    expect(() => n.update({ body: '   ' }, NOW)).toThrow(
      InvariantViolationError,
    );
  });

  it('update mediaUrls replaces the list', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    const next = n.update({ mediaUrls: ['s3://x.png', 's3://y.mp4'] }, NOW);
    expect(next.mediaUrls).toEqual(['s3://x.png', 's3://y.mp4']);
  });

  it('assertAuthoredBy passes on match', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    expect(() => n.assertAuthoredBy('staff-uuid-0001')).not.toThrow();
  });

  it('assertAuthoredBy throws on mismatch', () => {
    const n = ProgressNote.fromState(makeState(), NOW);
    expect(() => n.assertAuthoredBy('other-uuid')).toThrow(
      ProgressNoteNotAuthoredByYouError,
    );
  });

  it('toState/fromState round-trip preserves all fields', () => {
    const n = ProgressNote.fromState(
      makeState({ mediaUrls: ['s3://x'], body: 'preserved' }),
      NOW,
    );
    const restored = ProgressNote.fromState(n.toState(), NOW);
    expect(restored.toState()).toEqual(n.toState());
  });
});
