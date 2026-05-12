import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { Iin } from '@/shared-kernel/domain/value-objects/iin.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { Child } from './child.entity';
import { ArchiveReasonRequiredError } from '../errors/archive-reason-required.error';
import { ArchivedChildNotTransferableError } from '../errors/archived-child-not-transferable.error';
import { ChildAlreadyArchivedError } from '../errors/child-already-archived.error';
import { ChildNotArchivedError } from '../errors/child-not-archived.error';
import { GroupTransferToSelfError } from '../errors/group-transfer-to-self.error';
import { InvalidChildProfileError } from '../errors/invalid-child-profile.error';
import { InvalidChildStatusTransitionError } from '../errors/invalid-child-status-transition.error';

const STAFF_ID = '00000000-0000-0000-0000-0000000000ff';

const KG = KindergartenId.parse('11111111-1111-1111-1111-111111111111');
const ID = ChildId.parse('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const NOW = new Date('2026-04-28T12:00:00.000Z');

describe('Child domain entity', () => {
  it('createNew rejects empty full name', () => {
    expect(() =>
      Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: '   ',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      }),
    ).toThrow(InvalidChildProfileError);
  });

  it('createNew rejects future dob', () => {
    expect(() =>
      Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2030-01-01'),
        now: NOW,
      }),
    ).toThrow(InvalidChildProfileError);
  });

  it('updateProfile clears IIN when patch.iin = null', () => {
    const c = Child.createNew({
      id: ID,
      kindergartenId: KG,
      fullName: 'A',
      iin: Iin.parse('040315500123'),
      dateOfBirth: new Date('2021-09-15'),
      now: NOW,
    });
    c.updateProfile({ iin: null }, NOW);
    expect(c.iin).toBeUndefined();
  });

  it('transferToGroup throws when target equals current group', () => {
    const c = Child.createNew({
      id: ID,
      kindergartenId: KG,
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: '00000000-0000-0000-0000-0000000000aa',
      now: NOW,
    });
    expect(() =>
      c.transferToGroup('00000000-0000-0000-0000-0000000000aa', NOW),
    ).toThrow(GroupTransferToSelfError);
  });

  it('transferToGroup throws ArchivedChildNotTransferableError when the child is archived', () => {
    const c = Child.createNew({
      id: ID,
      kindergartenId: KG,
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: '00000000-0000-0000-0000-0000000000aa',
      now: NOW,
    });
    c.activate(NOW);
    c.archive(NOW, 'family moved', STAFF_ID);
    expect(() =>
      c.transferToGroup('00000000-0000-0000-0000-0000000000bb', NOW),
    ).toThrow(ArchivedChildNotTransferableError);
  });

  it('activate requires status=card_created', () => {
    const c = Child.createNew({
      id: ID,
      kindergartenId: KG,
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      now: NOW,
    });
    c.activate(NOW);
    expect(c.status.value).toBe('active');
    expect(() => c.activate(NOW)).toThrow(InvalidChildStatusTransitionError);
  });

  describe('archive', () => {
    const buildActive = (): Child => {
      const c = Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      });
      c.activate(NOW);
      return c;
    };

    it('archives an active child and persists reason + archivedAt', () => {
      const c = buildActive();
      const later = new Date('2026-05-12T09:30:00.000Z');
      c.archive(later, 'parent withdrew enrollment', STAFF_ID);
      expect(c.status.value).toBe('archived');
      expect(c.archivedAt).toEqual(later);
      expect(c.archiveReason).toBe('parent withdrew enrollment');
      expect(c.updatedAt).toEqual(later);
    });

    it('trims surrounding whitespace from reason', () => {
      const c = buildActive();
      c.archive(NOW, '   leaving for another kindergarten   ', STAFF_ID);
      expect(c.archiveReason).toBe('leaving for another kindergarten');
    });

    it('throws ChildAlreadyArchivedError when the child is already archived', () => {
      const c = buildActive();
      c.archive(NOW, 'first reason', STAFF_ID);
      expect(() => c.archive(NOW, 'second reason', STAFF_ID)).toThrow(
        ChildAlreadyArchivedError,
      );
    });

    it('throws InvalidChildStatusTransitionError when archiving a card_created child', () => {
      const c = Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      });
      expect(() => c.archive(NOW, 'reason', STAFF_ID)).toThrow(
        InvalidChildStatusTransitionError,
      );
    });

    it('throws ArchiveReasonRequiredError when reason is empty', () => {
      const c = buildActive();
      expect(() => c.archive(NOW, '', STAFF_ID)).toThrow(
        ArchiveReasonRequiredError,
      );
    });

    it('throws ArchiveReasonRequiredError when reason is whitespace-only', () => {
      const c = buildActive();
      expect(() => c.archive(NOW, '   \t  ', STAFF_ID)).toThrow(
        ArchiveReasonRequiredError,
      );
    });

    it('throws ArchiveReasonRequiredError when reason exceeds 500 chars', () => {
      const c = buildActive();
      const overlong = 'x'.repeat(501);
      expect(() => c.archive(NOW, overlong, STAFF_ID)).toThrow(
        ArchiveReasonRequiredError,
      );
    });

    it('accepts a reason of exactly 500 chars', () => {
      const c = buildActive();
      const maxReason = 'r'.repeat(500);
      c.archive(NOW, maxReason, STAFF_ID);
      expect(c.archiveReason).toBe(maxReason);
    });
  });

  describe('reactivate', () => {
    const buildArchived = (): Child => {
      const c = Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      });
      c.activate(NOW);
      c.archive(NOW, 'temporary leave', STAFF_ID);
      return c;
    };

    it('reactivates an archived child and clears archive metadata', () => {
      const c = buildArchived();
      const later = new Date('2026-05-12T10:00:00.000Z');
      c.reactivate(later, STAFF_ID);
      expect(c.status.value).toBe('active');
      expect(c.archivedAt).toBeUndefined();
      expect(c.archiveReason).toBeUndefined();
      expect(c.updatedAt).toEqual(later);
    });

    it('clears archive fields in toState() after reactivation', () => {
      const c = buildArchived();
      c.reactivate(NOW, STAFF_ID);
      const state = c.toState();
      expect(state.archivedAt).toBeNull();
      expect(state.archiveReason).toBeNull();
      expect(state.status).toBe('active');
    });

    it('throws ChildNotArchivedError when the child is active', () => {
      const c = Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      });
      c.activate(NOW);
      expect(() => c.reactivate(NOW, STAFF_ID)).toThrow(ChildNotArchivedError);
    });

    it('throws ChildNotArchivedError when the child is still card_created', () => {
      const c = Child.createNew({
        id: ID,
        kindergartenId: KG,
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
        now: NOW,
      });
      expect(() => c.reactivate(NOW, STAFF_ID)).toThrow(ChildNotArchivedError);
    });
  });
});
