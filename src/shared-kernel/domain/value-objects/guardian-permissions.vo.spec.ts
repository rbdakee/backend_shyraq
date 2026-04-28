import {
  ALL_PERMISSION_KEYS,
  DEFAULT_PERMISSIONS_BY_ROLE,
  GuardianPermissions,
  LOCKED_PERMISSION_KEYS,
  TOGGLEABLE_PERMISSION_KEYS,
} from './guardian-permissions.vo';
import { GuardianRelation } from './guardian-relation.vo';
import { LockedPermissionKeyError } from '../errors/locked-permission-key.error';
import { UnknownPermissionKeyError } from '../errors/unknown-permission-key.error';

describe('GuardianPermissions VO — whitelist constants', () => {
  it('TOGGLEABLE_PERMISSION_KEYS is exactly the 8 toggleable keys per matrix', () => {
    expect([...TOGGLEABLE_PERMISSION_KEYS].sort()).toEqual(
      [
        'view_timeline',
        'view_payments',
        'pay_invoices',
        'view_diagnostics',
        'view_content',
        'view_cctv',
        'receive_push_non_pickup',
        'create_requests',
      ].sort(),
    );
  });

  it('LOCKED_PERMISSION_KEYS is exactly prepayment + trusted_people_manage', () => {
    expect([...LOCKED_PERMISSION_KEYS].sort()).toEqual(
      ['prepayment', 'trusted_people_manage'].sort(),
    );
  });

  it('ALL_PERMISSION_KEYS contains 10 keys (8 toggleable + 2 locked)', () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(10);
  });
});

describe('GuardianPermissions VO — defaults(role)', () => {
  it('defaults(PRIMARY) — all 10 keys true', () => {
    expect(GuardianPermissions.defaults(GuardianRelation.PRIMARY)).toEqual({
      view_timeline: true,
      view_payments: true,
      pay_invoices: true,
      view_diagnostics: true,
      view_content: true,
      view_cctv: true,
      receive_push_non_pickup: true,
      create_requests: true,
      prepayment: true,
      trusted_people_manage: true,
    });
  });

  it('defaults(SECONDARY) — all toggleable true, locked false', () => {
    expect(GuardianPermissions.defaults(GuardianRelation.SECONDARY)).toEqual({
      view_timeline: true,
      view_payments: true,
      pay_invoices: true,
      view_diagnostics: true,
      view_content: true,
      view_cctv: true,
      receive_push_non_pickup: true,
      create_requests: true,
      prepayment: false,
      trusted_people_manage: false,
    });
  });

  it('defaults(NANNY) — only view_timeline true, others false', () => {
    expect(GuardianPermissions.defaults(GuardianRelation.NANNY)).toEqual({
      view_timeline: true,
      view_payments: false,
      pay_invoices: false,
      view_diagnostics: false,
      view_content: false,
      view_cctv: false,
      receive_push_non_pickup: false,
      create_requests: false,
      prepayment: false,
      trusted_people_manage: false,
    });
  });

  it('defaults(role) returns a fresh copy each call (immutable lookup)', () => {
    const a = GuardianPermissions.defaults(GuardianRelation.PRIMARY);
    a.view_timeline = false;
    expect(DEFAULT_PERMISSIONS_BY_ROLE.primary.view_timeline).toBe(true);
  });
});

describe('GuardianPermissions VO — fromObject / empty', () => {
  it('empty() creates an empty overrides VO', () => {
    expect(GuardianPermissions.empty().toJSON()).toEqual({});
  });

  it('fromObject({}) accepts empty object', () => {
    expect(GuardianPermissions.fromObject({}).toJSON()).toEqual({});
  });

  it('fromObject accepts a partial overrides set', () => {
    const vo = GuardianPermissions.fromObject({
      view_timeline: true,
      pay_invoices: false,
    });
    expect(vo.toJSON()).toEqual({ view_timeline: true, pay_invoices: false });
  });

  it('fromObject accepts a full overrides set including locked keys (read path)', () => {
    const all: Record<string, boolean> = {};
    for (const k of ALL_PERMISSION_KEYS) all[k] = true;
    const vo = GuardianPermissions.fromObject(all);
    expect(vo.toJSON()).toEqual(all);
  });

  it('fromObject rejects an unknown key', () => {
    expect(() => GuardianPermissions.fromObject({ foobar: true })).toThrow(
      UnknownPermissionKeyError,
    );
  });

  it('fromObject rejects a non-boolean value (string)', () => {
    expect(() =>
      GuardianPermissions.fromObject({ view_timeline: 'yes' }),
    ).toThrow(UnknownPermissionKeyError);
  });

  it('fromObject rejects null value', () => {
    expect(() =>
      GuardianPermissions.fromObject({ view_timeline: null }),
    ).toThrow(UnknownPermissionKeyError);
  });
});

describe('GuardianPermissions VO — merge', () => {
  it('merges a toggleable override over base', () => {
    const base = GuardianPermissions.fromObject({ view_timeline: true });
    const patch = GuardianPermissions.fromObject({
      view_timeline: false,
      pay_invoices: true,
    });
    const merged = base.merge(patch);
    expect(merged.toJSON()).toEqual({
      view_timeline: false,
      pay_invoices: true,
    });
  });

  it('merge does not mutate base', () => {
    const base = GuardianPermissions.fromObject({ view_timeline: true });
    base.merge(GuardianPermissions.fromObject({ view_timeline: false }));
    expect(base.toJSON()).toEqual({ view_timeline: true });
  });

  it.each([['prepayment'], ['trusted_people_manage']])(
    'merge rejects locked key %p in patch',
    (key) => {
      const base = GuardianPermissions.empty();
      const patch = GuardianPermissions.fromObject({ [key]: false });
      try {
        base.merge(patch);
        fail('expected LockedPermissionKeyError to be thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LockedPermissionKeyError);
        expect((e as LockedPermissionKeyError).key).toBe(key);
      }
    },
  );
});

describe('GuardianPermissions VO — effective(role)', () => {
  it('NANNY with override {view_payments: true} keeps default view_timeline=true and gets view_payments=true', () => {
    const vo = GuardianPermissions.fromObject({ view_payments: true });
    const eff = vo.effective(GuardianRelation.NANNY);
    expect(eff.view_payments).toBe(true);
    expect(eff.view_timeline).toBe(true); // default for nanny
    expect(eff.pay_invoices).toBe(false); // default for nanny
  });

  it('SECONDARY with no overrides returns defaults verbatim', () => {
    expect(
      GuardianPermissions.empty().effective(GuardianRelation.SECONDARY),
    ).toEqual(GuardianPermissions.defaults(GuardianRelation.SECONDARY));
  });

  it('PRIMARY with override turning view_cctv off — locked keys remain default-true', () => {
    const vo = GuardianPermissions.fromObject({ view_cctv: false });
    const eff = vo.effective(GuardianRelation.PRIMARY);
    expect(eff.view_cctv).toBe(false);
    expect(eff.prepayment).toBe(true);
    expect(eff.trusted_people_manage).toBe(true);
  });
});

describe('GuardianPermissions VO — overridesAgainst(role)', () => {
  it('returns only keys that differ from default', () => {
    // SECONDARY default: view_payments=true. Override view_payments=false ⇒ diff.
    // Override view_timeline=true ⇒ same as default ⇒ excluded.
    const vo = GuardianPermissions.fromObject({
      view_payments: false,
      view_timeline: true,
    });
    expect(vo.overridesAgainst(GuardianRelation.SECONDARY)).toEqual({
      view_payments: false,
    });
  });

  it('returns empty object when overrides match defaults', () => {
    const vo = GuardianPermissions.fromObject({ view_timeline: true });
    expect(vo.overridesAgainst(GuardianRelation.PRIMARY)).toEqual({});
  });
});

describe('GuardianPermissions VO — toJSON', () => {
  it('returns only overrides, not defaults', () => {
    const vo = GuardianPermissions.fromObject({ view_timeline: false });
    expect(vo.toJSON()).toEqual({ view_timeline: false });
  });

  it('returns a defensive copy (mutation does not affect VO)', () => {
    const vo = GuardianPermissions.fromObject({ view_timeline: true });
    const json = vo.toJSON();
    json.view_timeline = false;
    expect(vo.toJSON()).toEqual({ view_timeline: true });
  });
});
