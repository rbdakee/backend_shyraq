import {
  DiagnosticEntry,
  DiagnosticEntryState,
} from './diagnostic-entry.entity';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { DiagnosticEntryNotAuthoredByYouError } from '../errors/diagnostic-entry-not-authored-by-you.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

// Asia/Almaty is UTC+5 (no DST). Today (UTC) → today (Almaty) for the
// 10:00 UTC reference is 2026-05-07.
const TODAY_ALMATY = new Date('2026-05-07T00:00:00Z');
const YESTERDAY = new Date('2026-05-06T00:00:00Z');
const TOMORROW = new Date('2026-05-08T00:00:00Z');
const FAR_FUTURE = new Date('2030-12-31T00:00:00Z');

function makeState(
  overrides: Partial<DiagnosticEntryState> = {},
): DiagnosticEntryState {
  return {
    id: 'entry-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    templateId: 'tpl-uuid-0001',
    specialistId: 'staff-uuid-0001',
    assessmentDate: TODAY_ALMATY,
    data: { note: 'observed today', score: 7 },
    summary: null,
    recommendations: null,
    attachments: [],
    createdAt: NOW,
    updatedAt: NOW,
    rowVersion: 1,
    ...overrides,
  };
}

describe('DiagnosticEntry domain entity', () => {
  it('constructs with valid state (happy path)', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    expect(entry.childId).toBe('child-uuid-0001');
    expect(entry.attachments).toEqual([]);
  });

  it('accepts an assessmentDate that equals today (Almaty)', () => {
    expect(() =>
      DiagnosticEntry.fromState(
        makeState({ assessmentDate: TODAY_ALMATY }),
        NOW,
      ),
    ).not.toThrow();
  });

  it('accepts an assessmentDate of yesterday', () => {
    expect(() =>
      DiagnosticEntry.fromState(makeState({ assessmentDate: YESTERDAY }), NOW),
    ).not.toThrow();
  });

  it('throws when assessmentDate is tomorrow', () => {
    expect(() =>
      DiagnosticEntry.fromState(makeState({ assessmentDate: TOMORROW }), NOW),
    ).toThrow(InvariantViolationError);
  });

  it('throws when assessmentDate is far in the future', () => {
    expect(() =>
      DiagnosticEntry.fromState(makeState({ assessmentDate: FAR_FUTURE }), NOW),
    ).toThrow(/assessment_date_in_future/);
  });

  it('accepts a null summary, empty string summary and long text summary', () => {
    expect(() =>
      DiagnosticEntry.fromState(makeState({ summary: null }), NOW),
    ).not.toThrow();
    expect(() =>
      DiagnosticEntry.fromState(makeState({ summary: '' }), NOW),
    ).not.toThrow();
    expect(() =>
      DiagnosticEntry.fromState(
        makeState({ summary: 'lorem '.repeat(500) }),
        NOW,
      ),
    ).not.toThrow();
  });

  it('defaults attachments to [] when not provided', () => {
    const entry = DiagnosticEntry.fromState(
      makeState({ attachments: undefined as unknown as string[] }),
      NOW,
    );
    expect(entry.attachments).toEqual([]);
  });

  it('update patches data, summary, recommendations, attachments', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    const next = entry.update(
      {
        data: { note: 'patched', score: 9 },
        summary: 'progress observed',
        recommendations: 'continue',
        attachments: ['s3://bucket/a.pdf', 's3://bucket/b.pdf'],
      },
      LATER,
    );
    expect(next.data).toEqual({ note: 'patched', score: 9 });
    expect(next.summary).toBe('progress observed');
    expect(next.recommendations).toBe('continue');
    expect(next.attachments).toEqual([
      's3://bucket/a.pdf',
      's3://bucket/b.pdf',
    ]);
  });

  it('update preserves untouched fields', () => {
    const entry = DiagnosticEntry.fromState(
      makeState({ summary: 'orig', recommendations: 'orig-rec' }),
      NOW,
    );
    const next = entry.update({ summary: 'new' }, LATER);
    expect(next.summary).toBe('new');
    expect(next.recommendations).toBe('orig-rec');
    expect(next.data).toEqual({ note: 'observed today', score: 7 });
    expect(next.assessmentDate).toBe(TODAY_ALMATY);
  });

  it('update throws when data is set to a non-object', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    expect(() =>
      entry.update({ data: [] as unknown as Record<string, unknown> }, LATER),
    ).toThrow(InvariantViolationError);
  });

  it('assertAuthoredBy passes when the specialistId matches', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    expect(() => entry.assertAuthoredBy('staff-uuid-0001')).not.toThrow();
  });

  it('assertAuthoredBy throws DiagnosticEntryNotAuthoredByYouError on mismatch', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    expect(() => entry.assertAuthoredBy('other-staff-uuid')).toThrow(
      DiagnosticEntryNotAuthoredByYouError,
    );
  });

  it('toState/fromState round-trip preserves all fields', () => {
    const entry = DiagnosticEntry.fromState(
      makeState({
        summary: 's',
        recommendations: 'r',
        attachments: ['s3://a'],
      }),
      NOW,
    );
    const restored = DiagnosticEntry.fromState(entry.toState(), NOW);
    expect(restored.toState()).toEqual(entry.toState());
  });

  it('updatedAt advances on update', () => {
    const entry = DiagnosticEntry.fromState(makeState(), NOW);
    expect(entry.updatedAt).toBe(NOW);
    const next = entry.update({ summary: 'x' }, LATER);
    expect(next.updatedAt).toBe(LATER);
  });
});
