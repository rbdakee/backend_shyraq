import { EnrollmentAlreadyConvertedError } from '../errors/enrollment-already-converted.error';
import { EnrollmentLockedError } from '../errors/enrollment-locked.error';
import { EnrollmentMissingRequiredFieldsError } from '../errors/enrollment-missing-required-fields.error';
import { InvalidEnrollmentStatusTransitionError } from '../errors/invalid-enrollment-status-transition.error';
import {
  EnrollmentStatus,
  EnrollmentStatusValue,
} from '../value-objects/enrollment-status.vo';
import {
  CreateEnrollmentInput,
  Enrollment,
  EnrollmentState,
} from './enrollment.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const ENROLLMENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-04-30T12:00:00.000Z');
const LATER = new Date('2026-04-30T12:30:00.000Z');

const fixedClock = (when: Date) => ({ now: () => when });
const fixedId = (id: string) => (): string => id;

const baseInput = (
  overrides: Partial<CreateEnrollmentInput> = {},
): CreateEnrollmentInput => ({
  kindergartenId: KG,
  contactName: 'Aigerim',
  contactPhone: '+77001112233',
  childName: 'Asem',
  childDob: new Date('2022-09-15'),
  ...overrides,
});

/**
 * Build an Enrollment in an arbitrary status by hydrating from a synthetic
 * state. Lets the spec move past `new` without exercising every intermediate
 * transition first.
 */
const hydrateAt = (
  status: EnrollmentStatusValue,
  overrides: Partial<EnrollmentState> = {},
): Enrollment =>
  Enrollment.hydrate({
    id: ENROLLMENT_ID,
    kindergartenId: KG,
    childId: null,
    contactName: 'Aigerim',
    contactPhone: '+77001112233',
    childName: 'Asem',
    childDob: new Date('2022-09-15'),
    childIin: null,
    status,
    source: null,
    notes: null,
    assignedTo: null,
    statusChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

describe('Enrollment domain entity', () => {
  describe('createNew', () => {
    it('returns a new-status lead with timestamps from the clock', () => {
      const e = Enrollment.createNew(
        baseInput(),
        fixedClock(NOW),
        fixedId(ENROLLMENT_ID),
      );
      expect(e.id).toBe(ENROLLMENT_ID);
      expect(e.kindergartenId).toBe(KG);
      expect(e.status.value).toBe('new');
      expect(e.childId).toBeNull();
      expect(e.statusChangedAt).toEqual(NOW);
      expect(e.createdAt).toEqual(NOW);
      expect(e.updatedAt).toEqual(NOW);
    });

    it('defaults all optional fields to null', () => {
      const e = Enrollment.createNew(
        {
          kindergartenId: KG,
          contactName: 'A',
          contactPhone: '+77000000000',
        },
        fixedClock(NOW),
        fixedId(ENROLLMENT_ID),
      );
      expect(e.childName).toBeNull();
      expect(e.childDob).toBeNull();
      expect(e.childIin).toBeNull();
      expect(e.source).toBeNull();
      expect(e.notes).toBeNull();
      expect(e.assignedTo).toBeNull();
    });
  });

  describe('transitionTo (happy path)', () => {
    const allowed: Array<[EnrollmentStatusValue, EnrollmentStatusValue]> = [
      ['new', 'in_processing'],
      ['in_processing', 'waitlist'],
      ['in_processing', 'cancelled'],
      ['waitlist', 'in_processing'],
      ['cancelled', 'archive'],
      ['card_created', 'archive'],
    ];

    it.each(allowed)('transitions %s -> %s', (from, to) => {
      // card_created edge requires childId set (it's only reachable via
      // service.convertToCard which assignChild's the new card immediately).
      const overrides =
        from === 'card_created' ? { childId: CHILD_ID } : undefined;
      const e = hydrateAt(from, overrides);
      const result = e.transitionTo(
        EnrollmentStatus.from(to),
        STAFF_ID,
        'note',
        fixedClock(LATER),
      );
      expect(e.status.value).toBe(to);
      expect(e.statusChangedAt).toEqual(LATER);
      expect(e.updatedAt).toEqual(LATER);
      expect(result.logEntry).toEqual({
        enrollmentId: ENROLLMENT_ID,
        kindergartenId: KG,
        fromStatus: from,
        toStatus: to,
        changedBy: STAFF_ID,
        comment: 'note',
        createdAt: LATER,
      });
    });

    it('in_processing -> card_created produces a log entry with the right edge', () => {
      const e = hydrateAt('in_processing');
      const { logEntry } = e.transitionTo(
        EnrollmentStatus.CARD_CREATED,
        STAFF_ID,
        null,
        fixedClock(LATER),
      );
      expect(e.status.value).toBe('card_created');
      expect(logEntry.fromStatus).toBe('in_processing');
      expect(logEntry.toStatus).toBe('card_created');
      expect(logEntry.comment).toBeNull();
    });
  });

  describe('transitionTo (forbidden edges)', () => {
    const forbidden: Array<[EnrollmentStatusValue, EnrollmentStatusValue]> = [
      ['new', 'archive'],
      ['new', 'card_created'],
      ['new', 'cancelled'],
      ['new', 'waitlist'],
      ['in_processing', 'archive'],
      ['in_processing', 'new'],
      ['waitlist', 'card_created'],
      ['waitlist', 'archive'],
      ['archive', 'new'],
      ['archive', 'in_processing'],
      ['archive', 'card_created'],
      ['cancelled', 'in_processing'],
      ['card_created', 'in_processing'],
    ];

    it.each(forbidden)(
      '%s -> %s throws InvalidEnrollmentStatusTransitionError',
      (from, to) => {
        const e = hydrateAt(from);
        expect(() =>
          e.transitionTo(
            EnrollmentStatus.from(to),
            STAFF_ID,
            null,
            fixedClock(LATER),
          ),
        ).toThrow(InvalidEnrollmentStatusTransitionError);
      },
    );
  });

  describe('transitionTo to card_created — required-field guards', () => {
    it.each([
      ['childName', { childName: null }],
      ['childName', { childName: '   ' }], // blank string also counts
      ['childDob', { childDob: null }],
      ['contactName', { contactName: '' }],
      ['contactPhone', { contactPhone: '   ' }],
    ])(
      'rejects card_created when %s is missing',
      (label, overrides: Partial<EnrollmentState>) => {
        const e = hydrateAt('in_processing', overrides);
        expect(() =>
          e.transitionTo(
            EnrollmentStatus.CARD_CREATED,
            STAFF_ID,
            null,
            fixedClock(LATER),
          ),
        ).toThrow(EnrollmentMissingRequiredFieldsError);
      },
    );

    it('reports every missing field at once', () => {
      const e = hydrateAt('in_processing', {
        childName: null,
        childDob: null,
      });
      try {
        e.transitionTo(
          EnrollmentStatus.CARD_CREATED,
          STAFF_ID,
          null,
          fixedClock(LATER),
        );
        fail('expected EnrollmentMissingRequiredFieldsError');
      } catch (err) {
        expect(err).toBeInstanceOf(EnrollmentMissingRequiredFieldsError);
        const e2 = err as EnrollmentMissingRequiredFieldsError;
        expect(e2.missingFields).toEqual(
          expect.arrayContaining(['childName', 'childDob']),
        );
      }
    });

    it('rejects repeated card_created when childId is already set', () => {
      const e = hydrateAt('in_processing', { childId: CHILD_ID });
      expect(() =>
        e.transitionTo(
          EnrollmentStatus.CARD_CREATED,
          STAFF_ID,
          null,
          fixedClock(LATER),
        ),
      ).toThrow(EnrollmentAlreadyConvertedError);
    });
  });

  describe('assignChild', () => {
    it('sets childId and bumps updatedAt without status check', () => {
      const e = hydrateAt('in_processing');
      e.assignChild(CHILD_ID, fixedClock(LATER));
      expect(e.childId).toBe(CHILD_ID);
      expect(e.updatedAt).toEqual(LATER);
    });
  });

  describe('assignTo', () => {
    it('updates assignedTo and bumps updatedAt', () => {
      const e = hydrateAt('new');
      e.assignTo(STAFF_ID, fixedClock(LATER));
      expect(e.assignedTo).toBe(STAFF_ID);
      expect(e.updatedAt).toEqual(LATER);
    });

    it('throws EnrollmentLockedError on terminal (archive) status', () => {
      const e = hydrateAt('archive');
      expect(() => e.assignTo(STAFF_ID, fixedClock(LATER))).toThrow(
        EnrollmentLockedError,
      );
    });
  });

  describe('update', () => {
    it('applies non-undefined fields and bumps updatedAt', () => {
      const e = hydrateAt('new');
      e.update(
        {
          contactName: 'Renamed',
          notes: 'urgent',
          source: 'instagram',
        },
        fixedClock(LATER),
      );
      expect(e.contactName).toBe('Renamed');
      expect(e.notes).toBe('urgent');
      expect(e.source).toBe('instagram');
      // unchanged fields stay put
      expect(e.contactPhone).toBe('+77001112233');
      expect(e.updatedAt).toEqual(LATER);
    });

    it('treats undefined as "skip" — does not clear the field', () => {
      const e = hydrateAt('new', { notes: 'keep' });
      e.update({ contactName: 'Renamed' }, fixedClock(LATER));
      expect(e.notes).toBe('keep');
    });

    it('treats null as "clear" for nullable fields', () => {
      const e = hydrateAt('new', { notes: 'tmp', childIin: '040315500123' });
      e.update({ notes: null, childIin: null }, fixedClock(LATER));
      expect(e.notes).toBeNull();
      expect(e.childIin).toBeNull();
    });

    it.each<[EnrollmentStatusValue]>([
      ['card_created'],
      ['cancelled'],
      ['archive'],
    ])('throws EnrollmentLockedError when status is %p', (status) => {
      const overrides =
        status === 'card_created' ? { childId: CHILD_ID } : undefined;
      const e = hydrateAt(status, overrides);
      expect(() => e.update({ contactName: 'X' }, fixedClock(LATER))).toThrow(
        EnrollmentLockedError,
      );
    });
  });

  describe('toState / hydrate', () => {
    it('round-trips through hydrate(toState())', () => {
      const e = Enrollment.createNew(
        baseInput({ source: 'word_of_mouth' }),
        fixedClock(NOW),
        fixedId(ENROLLMENT_ID),
      );
      const round = Enrollment.hydrate(e.toState());
      expect(round.toState()).toEqual(e.toState());
    });
  });

  describe('timestamp tracking', () => {
    it('statusChangedAt updates on transition; updatedAt on every mutation', () => {
      const e = hydrateAt('new');
      const t1 = new Date('2026-04-30T13:00:00.000Z');
      const t2 = new Date('2026-04-30T13:05:00.000Z');
      const t3 = new Date('2026-04-30T13:10:00.000Z');

      e.transitionTo(
        EnrollmentStatus.IN_PROCESSING,
        STAFF_ID,
        null,
        fixedClock(t1),
      );
      expect(e.statusChangedAt).toEqual(t1);
      expect(e.updatedAt).toEqual(t1);

      e.assignTo(STAFF_ID, fixedClock(t2));
      expect(e.statusChangedAt).toEqual(t1); // unchanged: not a status edge
      expect(e.updatedAt).toEqual(t2);

      e.update({ notes: 'follow up' }, fixedClock(t3));
      expect(e.statusChangedAt).toEqual(t1);
      expect(e.updatedAt).toEqual(t3);
    });
  });
});
