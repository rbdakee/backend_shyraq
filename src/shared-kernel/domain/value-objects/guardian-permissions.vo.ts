import { LockedPermissionKeyError } from '../errors/locked-permission-key.error';
import { UnknownPermissionKeyError } from '../errors/unknown-permission-key.error';
import {
  GuardianRelation,
  GuardianRelationValue,
} from './guardian-relation.vo';

// Per endpoints.md §4.13 Guardian Permissions Matrix (synced 2026-04-26).
// Toggleable keys: parent (primary) can patch these for self/secondary/nanny.
export const TOGGLEABLE_PERMISSION_KEYS = [
  'view_timeline',
  'view_payments',
  'pay_invoices',
  'view_diagnostics',
  'view_content',
  'view_cctv',
  'receive_push_non_pickup',
  'create_requests',
] as const;

// Locked keys: read-only via defaults; cannot be patched.
export const LOCKED_PERMISSION_KEYS = [
  'prepayment',
  'trusted_people_manage',
] as const;

export const ALL_PERMISSION_KEYS = [
  ...TOGGLEABLE_PERMISSION_KEYS,
  ...LOCKED_PERMISSION_KEYS,
] as const;

export type ToggleablePermissionKey =
  (typeof TOGGLEABLE_PERMISSION_KEYS)[number];
export type LockedPermissionKey = (typeof LOCKED_PERMISSION_KEYS)[number];
export type PermissionKey = ToggleablePermissionKey | LockedPermissionKey;

const LOCKED_SET: ReadonlySet<string> = new Set(LOCKED_PERMISSION_KEYS);
const ALL_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);

// Defaults table — primary/secondary/nanny. nanny gets timeline only; primary
// is the only role with prepayment + trusted_people_manage. Locked keys are
// not user-toggleable; they appear here so `effective(role)` returns all 10.
export const DEFAULT_PERMISSIONS_BY_ROLE: Readonly<
  Record<GuardianRelationValue, Readonly<Record<PermissionKey, boolean>>>
> = Object.freeze({
  primary: Object.freeze({
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
  }),
  secondary: Object.freeze({
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
  }),
  nanny: Object.freeze({
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
  }),
});

// VO holds only *overrides* (the raw JSONB content of child_guardians.permissions).
// Defaults stay in code as a pure lookup — never persisted, so they can evolve
// without DB migration.
export class GuardianPermissions {
  private constructor(
    private readonly overrides: Readonly<Record<string, boolean>>,
  ) {}

  static empty(): GuardianPermissions {
    return new GuardianPermissions(Object.freeze({}));
  }

  static fromObject(obj: Record<string, unknown>): GuardianPermissions {
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!ALL_SET.has(key)) {
        throw new UnknownPermissionKeyError(key);
      }
      if (typeof value !== 'boolean') {
        throw new UnknownPermissionKeyError(key);
      }
      out[key] = value;
    }
    return new GuardianPermissions(Object.freeze(out));
  }

  // Returns the role's full default map. Pure lookup — does not produce a VO.
  static defaults(role: GuardianRelation): Record<PermissionKey, boolean> {
    return { ...DEFAULT_PERMISSIONS_BY_ROLE[role.value] };
  }

  // Merges `patch` over `this`. Rejects any locked key in patch — locked keys
  // change only through dedicated endpoints (PATCH .../rights), never via PATCH
  // permissions.
  merge(patch: GuardianPermissions): GuardianPermissions {
    for (const key of Object.keys(patch.overrides)) {
      if (LOCKED_SET.has(key)) {
        throw new LockedPermissionKeyError(key);
      }
    }
    return new GuardianPermissions(
      Object.freeze({ ...this.overrides, ...patch.overrides }),
    );
  }

  // All 10 keys: defaults(role) overlaid by overrides. For GET responses.
  effective(role: GuardianRelation): Record<PermissionKey, boolean> {
    const result = { ...DEFAULT_PERMISSIONS_BY_ROLE[role.value] } as Record<
      PermissionKey,
      boolean
    >;
    for (const [k, v] of Object.entries(this.overrides)) {
      // Cast safe because `fromObject`/`merge` validated keys against ALL_SET.
      result[k as PermissionKey] = v;
    }
    return result;
  }

  // Diff overrides ↔ defaults — useful for UI "modified" badges and audit logs.
  overridesAgainst(role: GuardianRelation): Record<string, boolean> {
    const defaults = DEFAULT_PERMISSIONS_BY_ROLE[role.value];
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(this.overrides)) {
      if (defaults[k as PermissionKey] !== v) {
        out[k] = v;
      }
    }
    return out;
  }

  // Raw overrides — what physically lives in child_guardians.permissions JSONB.
  toJSON(): Record<string, boolean> {
    return { ...this.overrides };
  }
}
