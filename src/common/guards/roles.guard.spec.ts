import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

function makeCtx(user: unknown): ExecutionContext {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

class FakeReflector extends Reflector {
  constructor(private readonly roles: string[] | undefined) {
    super();
  }
  override getAllAndOverride(key: any): any {
    if (key === ROLES_KEY) return this.roles;
    return undefined;
  }
}

describe('RolesGuard', () => {
  it('passes when no @Roles metadata', () => {
    const guard = new RolesGuard(new FakeReflector(undefined));
    expect(guard.canActivate(makeCtx({ sub: 'u', role: 'parent' }))).toBe(true);
  });

  it('passes when @Roles is empty array', () => {
    const guard = new RolesGuard(new FakeReflector([]));
    expect(guard.canActivate(makeCtx({ sub: 'u', role: 'parent' }))).toBe(true);
  });

  it('throws insufficient_role when role mismatch', () => {
    const guard = new RolesGuard(new FakeReflector(['admin']));
    expect(() =>
      guard.canActivate(makeCtx({ sub: 'u', role: 'parent' })),
    ).toThrow(ForbiddenException);
  });

  it('throws when no user role at all', () => {
    const guard = new RolesGuard(new FakeReflector(['admin']));
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('passes when role is in required list', () => {
    const guard = new RolesGuard(new FakeReflector(['admin', 'staff']));
    expect(guard.canActivate(makeCtx({ sub: 'u', role: 'admin' }))).toBe(true);
    expect(guard.canActivate(makeCtx({ sub: 'u', role: 'staff' }))).toBe(true);
  });
});
