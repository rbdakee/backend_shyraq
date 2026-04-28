import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { defer, firstValueFrom, Observable } from 'rxjs';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Wraps each handler invocation in a TypeORM transaction whose connection has
 * `SET LOCAL app.kindergarten_id = '<uuid>'` (or `app.bypass_rls = 'true'`)
 * applied. The transaction's EntityManager is then stored in
 * AsyncLocalStorage so that downstream repositories pick it up via
 * `tenantStorage.getStore()?.entityManager` and reuse the same connection —
 * the GUC is per-transaction and would not be visible from a different pooled
 * connection otherwise.
 *
 * Why an interceptor and not a guard:
 *   Guards return before the handler is called and AsyncLocalStorage's
 *   `enterWith` does not propagate to the NestJS handler invocation frame.
 *   `tenantStorage.run(...)` must therefore be invoked inside an interceptor
 *   that yields the request to NestJS only after the ALS scope is established.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const tenant = req.tenant;
    if (!tenant) return next.handle();

    return defer(() =>
      this.dataSource.transaction(async (manager) => {
        await applyTenantGuc(manager, tenant);
        const fullTenant: TenantContext = {
          ...tenant,
          entityManager: manager,
        };
        return tenantStorage.run(fullTenant, () =>
          firstValueFrom(next.handle(), { defaultValue: undefined }),
        );
      }),
    );
  }
}

async function applyTenantGuc(
  manager: EntityManager,
  tenant: TenantContext,
): Promise<void> {
  if (tenant.bypass) {
    await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
    return;
  }
  if (tenant.kgId !== null) {
    // SET LOCAL does not accept parameter binds, so we use a constant query
    // built from the kgId — but we validate first that it's a UUID to prevent
    // injection. (Postgres also casts the value via ::uuid in the policies,
    // which would reject non-UUIDs anyway.)
    if (!UUID_RE.test(tenant.kgId)) {
      throw new Error(`invalid_kindergarten_id: ${tenant.kgId}`);
    }
    await manager.query(`SET LOCAL app.kindergarten_id = '${tenant.kgId}'`);
    return;
  }
  // Neither bypass nor kgId — leave the GUCs unset. RLS policies will reject
  // any access to tenant-scoped tables in this transaction, which is the
  // correct behavior for unauthenticated/no-scope requests that somehow
  // reached the interceptor.
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
