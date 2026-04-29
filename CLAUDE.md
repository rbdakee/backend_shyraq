# CLAUDE.md — Shyraq Backend v2

Onboarding для будущих Claude-сессий в этом репо. Read before editing anything.

## 1. Project

**Shyraq** — multi-tenant SaaS для управления детскими садами. Один backend-инстанс обслуживает много садиков. Три client-приложения: Admin Web, Parent App, Staff App.

Repo `backend_shyraq_v2` — TypeORM + service.ts brocoders pattern. Старый репо `backend_shyraq` (Prisma + CQRS-light hexagonal) — read-only архив, не трогать.

## 2. Stack

- **NestJS 11** + TypeScript strict
- **TypeORM 0.3** + PostgreSQL 17
- **Redis 7** (ioredis) — OTP, blocklist, rate-limits, BullMQ от B9
- **REST** + **WebSocket** (B9+)
- Auth: JWT HS256 access + opaque refresh (SHA-256 hashed in DB)
- **Multi-tenancy**: PostgreSQL Row Level Security + явная передача `kindergarten_id`

## 3. Sources of truth

| Aspect | File |
|---|---|
| DB schema (human-readable) | [`docs/schema.dbml`](docs/schema.dbml) |
| DB schema (code SoT) | TypeORM миграции в `src/database/migrations/` |
| REST/WS endpoints | [`docs/endpoints.md`](docs/endpoints.md) |
| Business processes | [`docs/Shyraq BP.md`](docs/Shyraq%20BP.md) |
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| Implementation tracker | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) |

Docs-first: меняем feature/fix/refactor → сначала правим owning doc, потом код. Doc + code в одном PR/commit.

## 4. Module layout (brocoders + ports/adapters)

Каждый бизнес-модуль (`auth`, `users`, `kindergarten`, `staff`, `group`, `location`, `camera`, `child`, …) в `src/modules/<x>/`:

```
src/modules/<x>/
├── domain/
│   ├── entities/                    # POJO rich-aggregate (если есть инварианты)
│   ├── value-objects/
│   └── errors/                      # доменные ошибки модуля
├── dto/                             # @ApiProperty + class-validator
├── infrastructure/
│   └── persistence/
│       ├── <x>.repository.ts        # abstract class (port уровня модуля)
│       └── relational/
│           ├── entities/            # TypeORM @Entity()
│           ├── mappers/             # domain ↔ TypeORM-entity
│           └── repositories/        # реализации port'а (TypeORM-only)
├── <x>.controller.ts                # thin: validate → service → present
├── <x>.service.ts                   # вся бизнес-логика
├── <x>.module.ts                    # DI wiring
├── <x>.presenter.ts                 # domain → response DTO
└── <x>.service.spec.ts              # service-unit с in-memory fakes
```

**Layer rules:**
- `domain/` — без `@nestjs/*`, `typeorm`, `ioredis`, `class-validator`. Только shared-kernel + stdlib.
- `<x>.service.ts` — без прямых `Repository<X>`/`DataSource`/`ioredis` импортов; всё через injected ports.
- `infrastructure/persistence/relational/` — только TypeORM, никакой бизнес-логики.
- `<x>.controller.ts` — thin HTTP-edge, никаких прямых repo-вызовов.

**Ports & adapters** — `abstract class` для портов (`SmsPort`, `JwtTokenPort`, `PasswordHasherPort`, `OtpStorePort`, `TokenBlocklistPort`, `NotificationPort`, `ClockPort`). Адаптер `extends Port`, регистрируется `{ provide: Port, useClass: Adapter }`. DI-токен — сам класс-порта; `Symbol`/`@Inject('TOKEN')` не используется.

**shared-kernel** (`src/shared-kernel/`) — кросс-модульные VO, errors, ClockPort, TenantContext, `@Tenant()` decorator. Примитив попадает сюда только при использовании в 2+ модулях.

**Cross-cutting** (`src/common/`) — guards, interceptors, filters, чистый NestJS-HTTP-glue.

## 5. Multi-tenancy (RLS + explicit passing)

**RLS layer:** каждая tenant-scoped таблица имеет policy `kindergarten_id = current_setting('app.kindergarten_id')::uuid OR current_setting('app.bypass_rls') = 'true'` + `FORCE ROW LEVEL SECURITY` (применяется даже к owner role).

**Pipeline:**
1. `JwtAuthGuard` валидирует JWT, populates `req.user`.
2. `KindergartenScopeGuard` строит `req.tenant = { kgId, bypass }` (`@SuperAdminScope()` → `bypass=true`).
3. `TenantContextInterceptor` оборачивает handler в TypeORM transaction, делает `SET LOCAL app.kindergarten_id = '<uuid>'` (или `app.bypass_rls = 'true'`), затем `tenantStorage.run({ ...tenant, entityManager: manager }, () => handler())`.

**Repositories** берут `EntityManager` из `tenantStorage.getStore()?.entityManager` — иначе следующий запрос из pool'а не увидит per-transaction GUC. Service.ts всё равно явно передаёт `kindergarten_id` в repo-вызовы (читаемость + IDE-навигация); RLS — defense-in-depth.

**Two DB roles:**
- `shyraq` (SUPERUSER, table owner) — только миграции (`DATABASE_MIGRATION_USERNAME`).
- `shyraq_app` (NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE) — runtime app (`DATABASE_USERNAME`). Создаётся `InitExtensions` миграцией.

PostgreSQL exempts SUPERUSER/BYPASSRLS-роли от RLS даже при FORCE — поэтому app-connection обязан быть non-superuser, иначе изоляция физически не работает.

## 6. Local setup

```bash
# 1. Postgres + Redis (host PG 17/18 занимают 5432/5433 — поэтому 55432)
docker compose up -d postgres
docker run -d --name shyraq-redis-dev -p 6379:6379 redis:7-alpine

# 2. .env (скопировать из env-example-relational)
# DATABASE_PORT=55432
# DATABASE_USERNAME=shyraq_app           (runtime, NOSUPERUSER)
# DATABASE_MIGRATION_USERNAME=shyraq     (migration CLI, SUPERUSER)
# REDIS_PORT=6379

# 3. Migrations (под shyraq superuser)
npm run migration:run

# 4. App (под shyraq_app)
npm run start:dev
# → http://localhost:3000/docs (Swagger)
# → /api/v1/...
```

Migrations создаются: `npm run migration:create -- --name=<name>` или auto-generate из entity diff: `npm run migration:generate -- src/database/migrations/<Name>`.

## 7. Testing

Четыре уровня:

| Уровень | Файл | Команда |
|---|---|---|
| domain-unit | `*.entity.spec.ts`, `*.vo.spec.ts` | `npm test` |
| service-unit | `<x>.service.spec.ts` (рядом с service) | `npm test` |
| integration | `*.integration-spec.ts` / `*.integration.spec.ts` | `INTEGRATION_DB=1 npm test` (требует PG+Redis в docker) |
| e2e | `test/<x>.e2e-spec.ts` | `npm run test:e2e` |

Test naming: `it('returns ...')`, `it('throws ...')`, `it('rejects ...')`. **Не** `it('should ...')`.

Unit-тесты используют **рукописные in-memory fakes** для портов и репозиториев — не Jest auto-mock. Integration-тесты — против реального PG/Redis (docker compose), не моков. E2E — Supertest через HTTP.

`npm run test:e2e` использует `maxWorkers: 1` чтобы избежать FK violations при параллельном TRUNCATE между тестами.

## 8. Coding rules

**Domain layer:**
- POJO entities, без typeorm/external imports.
- Rich aggregates с инвариантами в методах (`Child.archive()`, `ChildGuardian.applyPermissionsPatch()`); CRUD-only entities — обычные классы.
- State machines — в методах domain-entity (например, child status `card_created → active → archived`; guardian status `pending → approved/rejected/revoked`).
- Доменные ошибки extends `DomainError` с `code: string` (например, `child_not_found`, `kindergarten_not_found`). `DomainErrorFilter` маппит в HTTP.

**Service layer (`<x>.service.ts`):**
- Не импортирует `typeorm`, `Repository`, `ioredis`. Только injected ports/repositories через DI.
- Принимает `kindergartenId: string` как первый аргумент бизнес-методов (явный intent, IDE-навигация).
- Транзакции — через injected `DataSource.transaction()` или, если repository нуждается в кастомной TX, метод репозитория принимает `manager?: EntityManager` или использует `tenantStorage` manager.

**Repositories:**
- `abstract class <X>Repository` в `<x>.repository.ts` (module-root). Методы — pure CRUD, принимают/возвращают **домен**, не TypeORM-entities.
- Реализация `<X>RelationalRepository extends <X>Repository` в `infrastructure/persistence/relational/repositories/`.
- `manager()` helper извлекает `tenantStorage.getStore()?.entityManager ?? this.repo.manager` — fallback нужен для CLI-скриптов и интеграционных тестов вне HTTP-pipeline.
- PG-ошибки маппятся в доменные: `23505` (unique violation) + constraint-name → `<X>AlreadyExistsError`. Никаких `Prisma` упоминаний (старый репо).

**DTO:**
- `@ApiProperty({ example: '...' })` — обязательно с реалистичным `example` для каждого поля.
- `@ApiResponse` с примерами для 200/201/400/401/403/404/409/422/429.
- Validation через class-validator (`@IsString`, `@IsUUID`, `@Matches`, `@IsEnum`, …).

**No "prisma" в именах** — repo, файл, переменная, комментарий. Старая парадигма.

**No use-case classes.** Один `service.ts` per module. Если service.ts разрастается выше ~700 строк — разбить на role-specific (`child.service.ts` admin + `parent-child.service.ts`), не на use-cases.

## 9. Adding a new module

1. Update `docs/schema.dbml`, `docs/endpoints.md`, `docs/Shyraq BP.md` — что меняется.
2. Создать миграцию: `npm run migration:create -- --name=<Name>`. Включить таблицы + RLS policy + `FORCE ROW LEVEL SECURITY` + indexes.
3. Создать структуру `src/modules/<x>/` по template из §4.
4. `domain/entities/<x>.entity.ts` — POJO с инвариантами + `toState()/fromState()`.
5. TypeORM-entity в `infrastructure/persistence/relational/entities/`. Mapper в `mappers/`.
6. `<x>.repository.ts` (abstract) + `<X>RelationalRepository`.
7. `<x>.service.ts` (бизнес-логика) + `<x>.service.spec.ts` (с in-memory fakes).
8. `<x>.controller.ts` + DTO с полным Swagger.
9. `<x>.module.ts` — DI wiring, `TypeOrmModule.forFeature([...])`, port↔adapter.
10. Зарегистрировать в `app.module.ts`.
11. E2E: cross-tenant phantom-row integration spec (kg_A vs kg_B), `test/<x>.e2e-spec.ts` через HTTP.

## 10. Do not

- Не создавать файлы вне SoT-таблицы без подтверждения.
- Не вводить use-case классы или CQRS-обвязку — service.ts достаточно.
- Не упоминать `prisma` нигде в коде/комментариях.
- Не мокать БД или Redis в integration-тестах.
- Не обходить RLS через прямой `DATABASE_USERNAME=shyraq` (superuser) в runtime — изоляция не сработает.
- Не пропускать husky pre-commit — fix issue + re-commit.
- Amend / force-push без явного запроса.

## 11. Pointers

- [`docs/architecture.md`](docs/architecture.md) — техническая архитектура
- [`docs/endpoints.md`](docs/endpoints.md) — REST/WS контракты
- [`docs/schema.dbml`](docs/schema.dbml) — DB модель (human-readable)
- [`docs/Shyraq BP.md`](docs/Shyraq%20BP.md) — бизнес-процессы
- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — батч-план + прогресс
- `src/database/migrations/` — DB SoT (TypeORM миграции)
- `env-example-relational` — все env-переменные с дефолтами и комментариями
