/**
 * Sealed enum-VO mirroring DB enum `enrollment_status` and the lead/inquiry
 * state-machine (B5). Allowed transitions live on the instance via
 * `canTransitionTo`; the entity is the only consumer that should call them.
 *
 * State machine (B5 §3):
 *   new           → in_processing
 *   in_processing → waitlist | card_created | cancelled
 *   waitlist      → in_processing
 *   card_created  → archive
 *   cancelled     → archive
 *   archive       → (terminal)
 */
export const ENROLLMENT_STATUS_VALUES = [
  'new',
  'in_processing',
  'waitlist',
  'card_created',
  'cancelled',
  'archive',
] as const;

export type EnrollmentStatusValue = (typeof ENROLLMENT_STATUS_VALUES)[number];

const TRANSITIONS: Readonly<
  Record<EnrollmentStatusValue, readonly EnrollmentStatusValue[]>
> = {
  new: ['in_processing'],
  in_processing: ['waitlist', 'card_created', 'cancelled'],
  waitlist: ['in_processing'],
  card_created: ['archive'],
  cancelled: ['archive'],
  archive: [],
};

export class EnrollmentStatus {
  static readonly NEW = new EnrollmentStatus('new');
  static readonly IN_PROCESSING = new EnrollmentStatus('in_processing');
  static readonly WAITLIST = new EnrollmentStatus('waitlist');
  static readonly CARD_CREATED = new EnrollmentStatus('card_created');
  static readonly CANCELLED = new EnrollmentStatus('cancelled');
  static readonly ARCHIVE = new EnrollmentStatus('archive');

  private constructor(public readonly value: EnrollmentStatusValue) {}

  /**
   * Sealed-instance lookup. Construction outside this class is forbidden
   * (private ctor) — `from` is the only entry point for raw strings, e.g.
   * during hydrate from DB or controller-side parse.
   */
  static from(value: string): EnrollmentStatus {
    switch (value) {
      case 'new':
        return EnrollmentStatus.NEW;
      case 'in_processing':
        return EnrollmentStatus.IN_PROCESSING;
      case 'waitlist':
        return EnrollmentStatus.WAITLIST;
      case 'card_created':
        return EnrollmentStatus.CARD_CREATED;
      case 'cancelled':
        return EnrollmentStatus.CANCELLED;
      case 'archive':
        return EnrollmentStatus.ARCHIVE;
      default:
        throw new Error(
          `enrollment_status must be one of ${ENROLLMENT_STATUS_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  canTransitionTo(next: EnrollmentStatus): boolean {
    return TRANSITIONS[this.value].includes(next.value);
  }

  isTerminal(): boolean {
    return this.value === 'archive';
  }

  equals(other: EnrollmentStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
