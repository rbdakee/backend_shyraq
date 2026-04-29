import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatus,
  EnrollmentStatusValue,
} from './enrollment-status.vo';

describe('EnrollmentStatus value object', () => {
  it('exposes sealed instances for every enum value', () => {
    expect(EnrollmentStatus.NEW.value).toBe('new');
    expect(EnrollmentStatus.IN_PROCESSING.value).toBe('in_processing');
    expect(EnrollmentStatus.WAITLIST.value).toBe('waitlist');
    expect(EnrollmentStatus.CARD_CREATED.value).toBe('card_created');
    expect(EnrollmentStatus.CANCELLED.value).toBe('cancelled');
    expect(EnrollmentStatus.ARCHIVE.value).toBe('archive');
  });

  it('exports ENROLLMENT_STATUS_VALUES with the full DB-enum order', () => {
    expect(ENROLLMENT_STATUS_VALUES).toEqual([
      'new',
      'in_processing',
      'waitlist',
      'card_created',
      'cancelled',
      'archive',
    ]);
  });

  describe('from', () => {
    it.each(ENROLLMENT_STATUS_VALUES.map((v) => [v]))(
      'from(%p) returns the matching sealed instance',
      (raw) => {
        const status = EnrollmentStatus.from(raw);
        expect(status.value).toBe(raw);
        // sealed: same input maps to same instance
        expect(EnrollmentStatus.from(raw)).toBe(status);
      },
    );

    it.each([['NEW'], [''], ['unknown'], ['Archive'], ['inprocessing']])(
      'from(%p) throws for unknown value',
      (raw) => {
        expect(() => EnrollmentStatus.from(raw)).toThrow();
      },
    );
  });

  describe('canTransitionTo', () => {
    // Transition matrix derived from the plan §3:
    //   new           → in_processing
    //   in_processing → waitlist | card_created | cancelled
    //   waitlist      → in_processing
    //   card_created  → archive
    //   cancelled     → archive
    //   archive       → (none)
    const allowed: Array<[EnrollmentStatusValue, EnrollmentStatusValue]> = [
      ['new', 'in_processing'],
      ['in_processing', 'waitlist'],
      ['in_processing', 'card_created'],
      ['in_processing', 'cancelled'],
      ['waitlist', 'in_processing'],
      ['card_created', 'archive'],
      ['cancelled', 'archive'],
    ];

    it.each(allowed)('allows %s -> %s', (from, to) => {
      expect(
        EnrollmentStatus.from(from).canTransitionTo(EnrollmentStatus.from(to)),
      ).toBe(true);
    });

    it('rejects every other from→to pair (and self-transitions)', () => {
      const allowedSet = new Set(allowed.map(([f, t]) => `${f}->${t}`));
      for (const from of ENROLLMENT_STATUS_VALUES) {
        for (const to of ENROLLMENT_STATUS_VALUES) {
          if (allowedSet.has(`${from}->${to}`)) continue;
          expect(
            EnrollmentStatus.from(from).canTransitionTo(
              EnrollmentStatus.from(to),
            ),
          ).toBe(false);
        }
      }
    });
  });

  describe('isTerminal', () => {
    it('returns true only for archive', () => {
      expect(EnrollmentStatus.ARCHIVE.isTerminal()).toBe(true);
    });

    it.each(
      ENROLLMENT_STATUS_VALUES.filter((v) => v !== 'archive').map((v) => [v]),
    )('returns false for %p', (raw) => {
      expect(EnrollmentStatus.from(raw).isTerminal()).toBe(false);
    });
  });

  describe('equals', () => {
    it('returns true for same value', () => {
      expect(
        EnrollmentStatus.IN_PROCESSING.equals(
          EnrollmentStatus.from('in_processing'),
        ),
      ).toBe(true);
    });

    it('returns false for different values', () => {
      expect(EnrollmentStatus.NEW.equals(EnrollmentStatus.WAITLIST)).toBe(
        false,
      );
    });
  });
});
