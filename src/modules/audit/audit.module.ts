import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditLogTypeOrmEntity } from './infrastructure/persistence/relational/entities/audit-log.typeorm.entity';
import { AuditLogRepository } from './infrastructure/persistence/audit-log.repository';
import { AuditLogRelationalRepository } from './infrastructure/persistence/relational/repositories/audit-log.relational.repository';

/**
 * Append-only audit trail over tenant-scoped mutations. Exports AuditService so
 * writer modules (attendance first) can `imports: [AuditModule]` and inject it.
 *
 * Deliberately a PLAIN module — NOT @Global(), and with NO Noop/fallback
 * adapter. A consumer must import AuditModule to get AuditService, so a missing
 * wiring fails loudly at bootstrap. The alternative shape (a @Global real
 * adapter plus a local Noop fallback) already bit this repo once: the local Noop
 * silently shadowed the real global provider and dropped writes on the floor
 * with no error. A DI failure is cheap; a silently empty audit trail is not.
 *
 * ClockPort is provided globally by SharedKernelModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditLogTypeOrmEntity])],
  providers: [
    AuditService,
    {
      provide: AuditLogRepository,
      useClass: AuditLogRelationalRepository,
    },
  ],
  exports: [AuditService],
})
export class AuditModule {}
