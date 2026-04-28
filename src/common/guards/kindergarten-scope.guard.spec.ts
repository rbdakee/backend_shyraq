import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { KindergartenScopeGuard } from './kindergarten-scope.guard';
import { SUPER_ADMIN_SCOPE_KEY } from '../decorators/super-admin-scope.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

function makeCtx(user: unknown): {
  ctx: ExecutionContext;
  req: { user: unknown; tenant?: unknown };
} {
  const req: { user: unknown; tenant?: unknown } = { user };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

class FakeReflector extends Reflector {
  constructor(private readonly map: Record<string, boolean>) {
    super();
  }
  override getAllAndOverride(key: any): any {
    return this.map[key] ?? false;
  }
}

describe('KindergartenScopeGuard', () => {
  it('passes @Public() routes', () => {
    const guard = new KindergartenScopeGuard(
      new FakeReflector({ [IS_PUBLIC_KEY]: true }),
    );
    expect(guard.canActivate(makeCtx(undefined).ctx)).toBe(true);
  });

  it('allows super_admin role only on @SuperAdminScope() handler', () => {
    const scoped = new KindergartenScopeGuard(
      new FakeReflector({ [SUPER_ADMIN_SCOPE_KEY]: true }),
    );
    expect(
      scoped.canActivate(makeCtx({ sub: 'sa', role: 'super_admin' }).ctx),
    ).toBe(true);

    const unscoped = new KindergartenScopeGuard(new FakeReflector({}));
    expect(
      unscoped.canActivate(makeCtx({ sub: 'sa', role: 'super_admin' }).ctx),
    ).toBe(false);
  });

  it('allows tenant roles (admin, parent) on non-super-admin handlers', () => {
    const guard = new KindergartenScopeGuard(new FakeReflector({}));
    expect(
      guard.canActivate(
        makeCtx({ sub: 'u', role: 'admin', kindergarten_id: 'kg-1' }).ctx,
      ),
    ).toBe(true);
    expect(guard.canActivate(makeCtx({ sub: 'u', role: 'parent' }).ctx)).toBe(
      true,
    );
  });

  it('allows when no user (@Public-style — JwtAuthGuard already passed)', () => {
    const guard = new KindergartenScopeGuard(new FakeReflector({}));
    expect(guard.canActivate(makeCtx(undefined).ctx)).toBe(true);
  });

  it('writes TenantContext into req.tenant for tenant roles', () => {
    const guard = new KindergartenScopeGuard(new FakeReflector({}));
    const { ctx, req } = makeCtx({
      sub: 'u',
      role: 'admin',
      kindergarten_id: 'kg-1',
    });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toEqual({ kgId: 'kg-1', bypass: false });
  });

  it('writes bypass context for super_admin on @SuperAdminScope() handler', () => {
    const guard = new KindergartenScopeGuard(
      new FakeReflector({ [SUPER_ADMIN_SCOPE_KEY]: true }),
    );
    const { ctx, req } = makeCtx({ sub: 'sa', role: 'super_admin' });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.tenant).toEqual({ kgId: null, bypass: true });
  });
});
