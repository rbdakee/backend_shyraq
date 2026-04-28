import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PendingRoleSelectGuard } from './pending-role-select.guard';
import { ALLOW_PENDING_ROLE_SELECT_KEY } from '../decorators/allow-pending-role-select.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

function makeCtx(user: unknown): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

class FakeReflector extends Reflector {
  constructor(private readonly map: Record<string, boolean>) {
    super();
  }
  override getAllAndOverride(key: any): any {
    return this.map[key] ?? false;
  }
}

describe('PendingRoleSelectGuard', () => {
  it('passes when no req.user', () => {
    const guard = new PendingRoleSelectGuard(new FakeReflector({}));
    expect(guard.canActivate(makeCtx(undefined))).toBe(true);
  });

  it('passes when JWT not pending', () => {
    const guard = new PendingRoleSelectGuard(new FakeReflector({}));
    expect(
      guard.canActivate(makeCtx({ sub: 'u', pending_role_select: false })),
    ).toBe(true);
  });

  it('throws 403 pending_role_select when pending JWT hits non-whitelisted handler', () => {
    const guard = new PendingRoleSelectGuard(new FakeReflector({}));
    expect(() =>
      guard.canActivate(makeCtx({ sub: 'u', pending_role_select: true })),
    ).toThrow(ForbiddenException);
  });

  it('passes when @AllowPendingRoleSelect() metadata present', () => {
    const guard = new PendingRoleSelectGuard(
      new FakeReflector({ [ALLOW_PENDING_ROLE_SELECT_KEY]: true }),
    );
    expect(
      guard.canActivate(makeCtx({ sub: 'u', pending_role_select: true })),
    ).toBe(true);
  });

  it('passes when @Public() bypasses everything', () => {
    const guard = new PendingRoleSelectGuard(
      new FakeReflector({ [IS_PUBLIC_KEY]: true }),
    );
    expect(
      guard.canActivate(makeCtx({ sub: 'u', pending_role_select: true })),
    ).toBe(true);
  });
});
