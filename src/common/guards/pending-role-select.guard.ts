import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_ROLE_SELECT_KEY } from '../decorators/allow-pending-role-select.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';

@Injectable()
export class PendingRoleSelectGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;
    if (isPublic) return true;

    const allowPending =
      this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_ROLE_SELECT_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return true;

    if (user.pending_role_select === true && !allowPending) {
      throw new ForbiddenException('pending_role_select');
    }
    return true;
  }
}
