import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { tenantStorage } from '@/database/tenant-storage';
import type { TenantContext } from '../../application/tenant/tenant-context';

export const Tenant = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): TenantContext => {
    const store = tenantStorage.getStore();
    if (!store)
      throw new Error(
        'TenantContext missing — KindergartenScopeGuard must wrap handler',
      );
    return store;
  },
);
