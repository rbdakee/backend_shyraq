# Shyraq — Backend & Database Architecture

## Context

Shyraq — multi-tenant SaaS для управления детскими садами. Один инстанс обслуживает несколько садиков (multi-tenant). Три клиентских приложения: Admin Web, Parent App, Staff App. Документ описывает архитектуру бэкенда v2.

**Стек:**
- Backend: **NestJS 11** (TypeScript, strict)
- ORM: **TypeORM 0.3** (PostgreSQL driver)
- Primary DB: **PostgreSQL 17**
- Cache / OTP / queue (B9+): **Redis 7** (ioredis)
- API: **REST** + **WebSocket** (B9+)
- File Storage: **S3-совместимое** (B17+)
- Multi-tenancy: **PostgreSQL Row Level Security** + явная передача `kindergarten_id` (defense-in-depth)

Источники истины:
- DB-модель (human-readable): [`docs/schema.dbml`](schema.dbml)
- DB-модель (code SoT): TypeORM миграции в `src/database/migrations/`
- REST/WS endpoints: [`docs/endpoints.md`](endpoints.md)
- Бизнес-процессы: [`docs/Shyraq BP.md`](Shyraq%20BP.md)
- Implementation tracker: [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md)

---

## 1. Module structure

Модульный layout — **brocoders nestjs-boilerplate pattern**, адаптированный под ports & adapters там, где есть смысл (внешние сервисы, репозитории). Бизнес-логика живёт в одном `service.ts` per module, не в use-case-классах.

### 1.1 Per-module folder template

Каждый бизнес-модуль (`auth`, `users`, `kindergarten`, `staff`, `group`, `location`, `camera`, `child`, …) лежит в `src/modules/<x>/` и следует одной структуре:

```
src/modules/<x>/
├── domain/
│   ├── entities/                       # POJO rich-aggregate (если есть инварианты)
│   │   └── <name>.entity.ts            # без typeorm/external imports
│   ├── value-objects/                  # локальные VO
│   └── errors/                         # доменные ошибки модуля
├── dto/                                # request/response DTO с @ApiProperty + class-validator
├── infrastructure/
│   └── persistence/
│       ├── <x>.repository.ts           # abstract class — port-уровня модуля
│       └── relational/
│           ├── entities/               # TypeORM @Entity()-классы
│           ├── mappers/                # domain ↔ TypeORM-entity
│           └── repositories/           # реализации <x>.repository.ts (TypeORM-only)
├── <x>.controller.ts                   # thin HTTP-edge: validate → service → present
├── <x>.service.ts                      # вся бизнес-логика модуля
├── <x>.module.ts                       # DI wiring: { provide: <X>Repository, useClass: <X>RelationalRepository }
├── <x>.presenter.ts                    # domain → response DTO mapping (если нужен)
└── <x>.service.spec.ts                 # service-unit с in-memory fake repos
```

Дополнительные сегменты, появляющиеся по мере роста модуля:
- `<x>.controller.ts` может разделяться на role-specific (например, `child.controller.ts` для admin, `parent-child.controller.ts` для parent, `parent-approval.controller.ts` для approval-flow).
- Несколько ports/repositories в одном модуле — каждый отдельным файлом (`infrastructure/persistence/child.repository.ts` + `infrastructure/persistence/child-guardian.repository.ts`).
- Лёгкие helper'ы (`auth-result.view.ts`, `refresh-token.helper.ts`, `welcome-sms.templates.ts`) лежат в module-root рядом с `<x>.service.ts`; use-case-классов нет.

### 1.2 Layer rules (lint-checked + code-review)

| Слой | Что разрешено | Что запрещено |
|---|---|---|
| `domain/` | shared-kernel, стандартная библиотека | импорты `@nestjs/*`, `typeorm`, `ioredis`, `class-validator` |
| `dto/` | `@nestjs/swagger`, `class-validator`, `class-transformer`, доменные типы | typeorm, ioredis, прямые вызовы репозиториев |
| `<x>.service.ts` | injected ports/repositories, shared-kernel, доменные сущности | прямые `Repository<X>`/`DataSource` импорты, `ioredis`, прямые `axios`/`fetch` |
| `infrastructure/persistence/relational/` | `typeorm`, `@nestjs/typeorm`, `pg` driver errors | бизнес-логика; все методы — pure CRUD + маппинг |
| `<x>.controller.ts` | `@nestjs/common`, decorators, DTOs, `service`-вызовы | прямые репозиторные вызовы |

Нарушения этих правил ловятся в code-review, повторяющиеся — закрепляются eslint-правилом.

### 1.3 Ports & adapters

Те внешние взаимодействия, у которых нужна switchability (mock vs real) или unit-test изоляция, оформляются как `abstract class`-порт + Nest-провайдер:

| Порт | Адаптер | Назначение |
|---|---|---|
| `SmsPort` | `MockSmsAdapter` | OTP-SMS отправка (real-провайдер — после выбора в Active questions) |
| `JwtTokenPort` | `JsonwebtokenAdapter` | Issue/verify access JWT (HS256) |
| `PasswordHasherPort` | `BcryptPasswordHasher` | bcrypt hash/verify (cost 12 prod, 4 test) |
| `OtpStorePort` | `RedisOtpStore` | OTP code storage с TTL + lockout-counter |
| `TokenBlocklistPort` | `RedisTokenBlocklist` | JWT JTI blocklist (logout, role-select rotation) |
| `NotificationPort` | `LoggingNotificationAdapter` | Push/email уведомления (B9 заменит на BullMQ + FCM/APNS + WS) |
| `ClockPort` | `SystemClock` (prod) / `FixedClock` (test) | `now()` — testable |

Регистрация в `<x>.module.ts`:

```typescript
@Module({
  providers: [
    { provide: SmsPort, useClass: MockSmsAdapter },
    { provide: JwtTokenPort, useClass: JsonwebtokenAdapter },
    { provide: AuthService, useClass: AuthService },
  ],
})
```

DI-токен — сам класс-порта; `Symbol`/`@Inject('TOKEN')` не используется. Адаптер — `extends Port`, не `implements`, чтобы TS форсил полноту сигнатур.

Repository-port (`<x>.repository.ts`) объявляется аналогично — `abstract class` в `infrastructure/persistence/`, реализация `<X>RelationalRepository` extends его в `infrastructure/persistence/relational/repositories/`. Methods принимают/возвращают **домен** (POJO entities), не TypeORM-entities.

### 1.4 shared-kernel

Кросс-модульные доменные примитивы лежат в `src/shared-kernel/`:

```
src/shared-kernel/
├── domain/
│   ├── value-objects/        # Phone, Iin, Email, KindergartenId, UserId, SaasUserId, ChildId,
│   │                         # GuardianRelation, GuardianStatus, ChildStatus, GuardianPermissions,
│   │                         # MonetaryAmount, Locale, KindergartenSlug
│   ├── errors/               # DomainError base, NotFoundError, ConflictError, ...
│   └── i18n/                 # localizeJsonb, resolveLocale (pure functions)
├── application/
│   ├── tenant/               # TenantContext type
│   └── ports/                # ClockPort
├── infrastructure/
│   └── adapters/             # SystemClock, FixedClock
├── interface/
│   └── decorators/           # @Tenant(), @CurrentUser()
└── shared-kernel.module.ts   # @Global() — экспортирует ClockPort + NotificationPort
```

Правило отнесения: примитив попадает в shared-kernel только если используется в 2+ модулях.

### 1.5 Cross-cutting (top-level)

| Директория | Роль |
|---|---|
| `src/config/` | typed config (NestJS `ConfigModule.forRoot` + `registerAs`); валидация при старте |
| `src/database/` | `data-source.ts` (TypeORM CLI), `typeorm-config.service.ts`, `tenant-storage.ts` (AsyncLocalStorage), миграции |
| `src/redis/` | ioredis singleton + `RedisModule` |
| `src/common/` | guards (`JwtAuthGuard`, `KindergartenScopeGuard`, `PendingRoleSelectGuard`, `RolesGuard`, `ChildAccessGuard`), interceptors (`TenantContextInterceptor`), filters (`DomainErrorFilter`), декораторы (`@Public`, `@Roles`, `@SuperAdminScope`, `@AllowPendingRoleSelect`), типы (`AuthenticatedRequest`) |
| `src/i18n/` | nestjs-i18n loader |
| `src/shared-kernel/` | см. §1.4 |

Guards/interceptors/filters могут инжектить ports через DI — это разрешённый путь использовать Redis/внешние ресурсы из `src/common/` (адаптер живёт в infrastructure-слое целевого модуля).

---

## 2. Persistence

### 2.1 TypeORM setup

- Connection — `TypeOrmModule.forRootAsync` через `TypeOrmConfigService`. `synchronize: false` всегда; схема управляется только миграциями.
- Миграции — `src/database/migrations/<timestamp>-<name>.ts`. Запуск: `npm run migration:run`. Reverse: `npm run migration:revert`.
- Entities регистрируются per-модуль через `TypeOrmModule.forFeature([<X>Entity, ...])`.

### 2.2 Two database roles

| Role | Привилегии | Используется |
|---|---|---|
| `shyraq` (superuser, table owner) | SUPERUSER, владелец схемы | только миграциями (`DATABASE_MIGRATION_USERNAME`) |
| `shyraq_app` | NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE | runtime приложение (`DATABASE_USERNAME`) |

Создаётся в первой миграции `InitExtensions` (idempotent `DO $$ ... $$`). PostgreSQL exempts SUPERUSER и BYPASSRLS-роли от RLS даже при `FORCE ROW LEVEL SECURITY`, поэтому app-connection обязан использовать non-superuser role — иначе tenant isolation физически не работает.

### 2.3 Repository pattern

Repository-port — `abstract class` в `infrastructure/persistence/<x>.repository.ts`, методы принимают/возвращают доменные сущности. Реализация `<X>RelationalRepository` (в `infrastructure/persistence/relational/repositories/`):

1. Извлекает `EntityManager` из `tenantStorage.getStore()?.entityManager`; fallback — `this.repo.manager` (для CLI-скриптов и интеграционных тестов вне HTTP-pipeline).
2. Делает CRUD через `manager().getRepository(<TypeOrmEntity>)`.
3. Маппит результат через mapper (`ChildMapper.toDomain` / `.toEntity`).
4. Конвертирует PG-ошибки (P-коды) в доменные ошибки: `23505` (unique violation) + constraint-name → `ChildIinAlreadyExistsError` и т.п.

Все репозитории принимают `kindergarten_id` явным первым аргументом (`findById(kgId, id)`, `list(kgId, filters, page)`) — IDE-навигация и явная intent. RLS на DB-стороне — defense-in-depth, не replacement читаемости.

---

## 3. Multi-tenancy (Row Level Security + explicit passing)

### 3.1 Pipeline

```
Request
  → JwtAuthGuard          (валидирует JWT, populates req.user)
  → KindergartenScopeGuard (читает kgId из req.user, populates req.tenant; @SuperAdminScope() → bypass=true)
  → PendingRoleSelectGuard (отклоняет pending-role-select JWT на non-allowlist handlers)
  → TenantContextInterceptor (см. §3.2)
  → controller.method
```

`req.tenant: TenantContext` — `{ kgId: string | null, bypass: boolean }`. SuperAdmin-controllers помечают класс `@SuperAdminScope()` → guard ставит `{ kgId: null, bypass: true }`.

### 3.2 TenantContextInterceptor

Каждый запрос с `req.tenant` оборачивается в TypeORM-транзакцию. Внутри транзакции выполняется `SET LOCAL app.kindergarten_id = '<uuid>'` (или `SET LOCAL app.bypass_rls = 'true'` для SuperAdmin), затем `tenantStorage.run({ ...tenant, entityManager: manager }, () => handler())`.

Почему interceptor, не guard: `AsyncLocalStorage.enterWith()` в guard-фрейме НЕ протекает в handler-frame под NestJS pipeline. Только interceptor с `tenantStorage.run(...)` гарантирует scope для всего handler-execution и его async-потомков.

`SET LOCAL` — per-transaction, поэтому handler и downstream репозитории должны переиспользовать **тот же** EntityManager: иначе следующий запрос из pool'а не увидит GUC. Репозитории берут manager из `tenantStorage.getStore()?.entityManager`.

Validation: `kgId` проверяется UUID-regex до подстановки (`SET LOCAL` не принимает параметры через bind, только литерал).

### 3.3 RLS policies

Каждая tenant-scoped таблица имеет:

```sql
ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <name> FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <name>
  USING (
    kindergarten_id = current_setting('app.kindergarten_id', true)::uuid
    OR coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
  )
  WITH CHECK (
    kindergarten_id = current_setting('app.kindergarten_id', true)::uuid
    OR coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
  );
```

`FORCE ROW LEVEL SECURITY` — RLS применяется **даже к owner role**. Это закрывает дыру, через которую table owner иначе обходил policy.

Проверка работоспособности — phantom-row integration spec в каждом tenant-scoped модуле: создаём строку под kgA, переключаем GUC на kgB, убеждаемся что `findById(kgB, id)` возвращает null — даже если ID известен.

### 3.4 SuperAdmin endpoints

Класс контроллера помечается `@SuperAdminScope()`. Guard ставит `{ kgId: null, bypass: true }`, interceptor выполняет `SET LOCAL app.bypass_rls = 'true'` — RLS пропускает все строки. Service.ts при этом всё равно явно передаёт `kgId` в repo-вызовы там, где скоуп всё-таки логически tenant'овский (например, `archiveCascade(kgId)`).

### 3.5 Cross-tenant tables

`users`, `refresh_tokens` (с nullable `kindergarten_id`), `saas_users`, `saas_refresh_tokens` — глобальные. RLS не накладывается. Изоляция обеспечивается на уровне сервиса (например, refresh-token revocation scoped по `kindergarten_id` + `user_id`).

---

## 4. Auth & Identity

### 4.1 Tokens

- **Access token** — JWT HS256, TTL 15 мин (`AUTH_JWT_TOKEN_EXPIRES_IN`). Claims: `{ sub: userId, role, kindergarten_id?, jti, pending_role_select? }`.
- **Refresh token** — opaque random hex (32 байта = 64 hex), TTL 30 дней (`REFRESH_TOKEN_TTL_DAYS`). В клиенте — сырой токен; в БД (`refresh_tokens` / `saas_refresh_tokens`) — только `token_hash = SHA-256(raw)`. Ревокация — `UPDATE ... SET revoked_at = NOW()`.
- **Logout** — добавляет `jti` access-токена в `TokenBlocklistPort` (Redis с TTL до истечения JWT) + revoke текущего refresh-токена.

### 4.2 OTP flow

`POST /auth/otp/request` → `OtpStorePort.create(phone, code, ttl)` (Redis-hash с attempts=0). SMS-отправка через `SmsPort` (mock логирует код). `OTP_TEST_PHONES` whitelist — bypass real SMS, возвращает `OTP_TEST_CODE` для test-сценариев.

`POST /auth/otp/verify` → `OtpStorePort.verify(phone, code)`:
- При несоответствии — `incrementAttempts()` (EXISTS pre-check защищает от TTL-edge: naked HINCRBY на expired hash создал бы запись с attempts=1 и обнулил lockout).
- 3 неудачных попытки — `lock(phone, lockTtl)`.

При успехе — issue access + refresh пары. Multi-role staff (≥2 active `staff_members`) получает временный access JWT с `pending_role_select: true` (без `kindergarten_id`); refresh не выдаётся до выбора. `POST /auth/role/select` принимает `kindergarten_id`, проверяет активную роль, выдаёт полную пару, добавляет временный JTI в blocklist.

### 4.3 SuperAdmin auth

Email + password (`saas_users` table). `POST /super-admin/auth/login` → bcrypt verify → access + refresh (`saas_refresh_tokens`). Отдельная таблица — никакого полиморфизма с `users.refresh_tokens`.

### 4.4 Guards summary

| Guard | Роль |
|---|---|
| `JwtAuthGuard` (global) | Валидирует JWT, проверяет blocklist, populates `req.user`. Skip при `@Public()`. |
| `KindergartenScopeGuard` (global) | Building `req.tenant` из user.kindergarten_id (или `null/bypass=true` при `@SuperAdminScope()`). |
| `PendingRoleSelectGuard` (global) | Отклоняет JWT с `pending_role_select: true` на handler'ах без `@AllowPendingRoleSelect()`. |
| `RolesGuard` | Проверяет `@Roles('admin' | 'parent' | 'staff' | 'super_admin')`. |
| `ChildAccessGuard` | Cross-tenant lookup `child_guardians(child_id, user_id)`; ставит `req.tenant` + `req.guardianRecord`. Используется на `/parent/children/:id/*` и `/parent/approvals/:guardianId/*`. |

---

## 5. Tests

Четыре уровня — каждый PR держит свой уровень зелёным.

| Уровень | Файл | Гейтинг | Назначение |
|---|---|---|---|
| **domain-unit** | `*.entity.spec.ts`, `*.vo.spec.ts` (внутри `domain/`) | `npm test` | POJO entity invariants, state-machine transitions, VO factory validation. Без DI, без Nest. |
| **service-unit** | `<x>.service.spec.ts` (рядом с `<x>.service.ts`) | `npm test` | Бизнес-flow с in-memory fake repos и fake ports (рукописные, не Jest auto-mock). Без PG, без Redis. |
| **integration** | `*.integration-spec.ts` или `*.integration.spec.ts` | `INTEGRATION_DB=1 npm test` | TypeORM-репозитории против реального PG + Redis (docker compose). Покрывают partial-unique races, RLS phantom-rows, trigger-violations, P-codes. Gated env-флагом — `npm test` остаётся быстрым и docker-free. |
| **e2e** | `test/<x>.e2e-spec.ts` | `npm run test:e2e` | HTTP через Supertest. Cross-tenant isolation, auth flows, full BP-сценарии. PG+Redis в docker. `maxWorkers: 1` чтобы избежать FK-violations при параллельном TRUNCATE между тестами. |

Naming convention — `it('returns ...')` / `it('throws ...')` / `it('rejects ...')`. **Не** `it('should ...')`. Subject — sentence-case, present-tense, без Mocha-вского "should".

---

## 6. Process topology

До B9 — single-process. На B9 (Notifications + WebSocket) репо разделяется на три cloud-процесса split-entrypoints:

| Процесс | Entry | Назначение |
|---|---|---|
| **api** | `src/main.api.ts` | REST endpoints, payment-webhook receivers (ack 200 + enqueue в BullMQ) |
| **worker** | `src/main.worker.ts` | BullMQ consumers + repeatable jobs: billing-cron, FCM/APNS, OFD-fiscalization, schedule/menu auto-copy, story TTL cleanup, identity-QR rotation |
| **ws** | `src/main.ws.ts` | WebSocket gateway, real-time events (BP §10), Redis Pub/Sub fan-out из api/worker |

Все три процесса делят один Postgres + один Redis. Communication: `api → worker` через BullMQ; `api/worker → ws` через Redis Pub/Sub.

Не разделяется в отдельные сервисы:
- **admin/parent/super-admin** — same code, same DB. Network-сегментация делается на reverse proxy (`/super-admin/*` за IP-allowlist/VPN).
- **auth** — JWT stateless, отдельный сервис плодит сетевой hop без выгоды при HS256.
- **scheduler** — внутри `worker` как BullMQ repeatable jobs.
- **payment-webhook receiver** — внутри `api`.

### 6.1 Edge stack (B18.5+)

Face recognition и CCTV stack физически работают **на железке внутри садика**, не в cloud (mini-PC ~$400 docker-compose из 5 процессов: edge-agent, face-worker, cctv-gateway, MediaMTX, локальный Qdrant). Cloud-БД **никогда** не содержит face embeddings или сырое видео.

Cloud↔edge — outbound-only WSS (садик за NAT/dynamic IP), mTLS, command/event pattern через таблицы `edge_commands` / `edge_health` / `kindergarten_edge_credentials` (появятся на B18.5). Stream-tokens — RS256 JWT, локальная верификация на edge через cloud public key.

Reasoning: bandwidth (12 камер × 4 Mbit/s upload не пройдёт), latency (<500ms на турникете), compliance (биометрия = особо чувствительные ПДн по ЗРК), offline-resilience (садик не парализован при пропаже интернета), cost ($400 единоразово vs $300–500/мес GPU-инстанс).

Полная топология edge-стека и cloud↔edge протокола — будет вынесена в отдельный документ при подходе к B18.5.

---

## 7. Verification

Минимальный набор green-ов перед закрытием батча:
- `npm run build` — exit 0.
- `npm run lint` — exit 0.
- `npm test` — все unit suites green.
- `INTEGRATION_DB=1 npm test` — все integration suites green (требует docker compose с PG+Redis).
- `npm run test:e2e` — все e2e suites green (тот же docker stack).
- Swagger `/docs` поднимается; openapi.json содержит все новые endpoints.
- Cross-tenant phantom-row integration spec покрыт для каждой новой tenant-scoped таблицы.
