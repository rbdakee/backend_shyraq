import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { Iin } from '@/shared-kernel/domain/value-objects/iin.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { Child } from './child.entity';
import { GroupTransferToSelfError } from '../errors/group-transfer-to-self.error';
import { InvalidChildProfileError } from '../errors/invalid-child-profile.error';
import { InvalidChildStatusTransitionError } from '../errors/invalid-child-status-transition.error';

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

  it('archive then restore works; archive on archived is idempotent', () => {
    const c = Child.createNew({
      id: ID,
      kindergartenId: KG,
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      now: NOW,
    });
    c.archive('reason', NOW);
    expect(c.status.value).toBe('archived');
    c.archive('again', NOW); // idempotent
    expect(c.status.value).toBe('archived');
    c.restore(NOW);
    expect(c.status.value).toBe('active');
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
});
