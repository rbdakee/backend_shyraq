# Shyraq — Backend & Database Architecture

## Context

Shyraq — multi-tenant SaaS для управления детскими садами. Один инстанс обслуживает несколько садиков (multi-tenant). Три клиентских приложения: Admin Web, Parent App, Staff App. Документ описывает архитектуру бэкенда v2.

**Стек:**
- Backend: **NestJS 11** (TypeScript, strict)
- ORM: **TypeORM 0.3** (PostgreSQL driver)
- Primary DB: **PostgreSQL 17**
- Cache / OTP / queue (B9+): **Redis 7** (ioredis)
- API: **REST** + **WebSocket** (B9+)
- File Storage: **`LocalFileStorageAdapter`** (B17, диск) / **`S3FileStorageAdapter`** (Phase B, S3-совместимый — ps.kz Object Storage, Yandex). Env-switch `FILE_STORAGE_PROVIDER=local|s3|yandex`
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
| `FileStoragePort` | `LocalFileStorageAdapter` (default, B17) / `S3FileStorageAdapter` (Phase B) | Загрузка/чтение/удаление медиа-файлов. `local` — хранит на диске `<uploads>/<kg_id>/<…>/<uuid>.<ext>`. `s3`/`yandex` — S3-совместимое хранилище (ps.kz `object.pscloud.io`, Yandex `storage.yandexcloud.net`) через `@aws-sdk/client-s3`. Оба адаптера возвращают URL `/api/v1/media/<key>` — файлы раздаются только через auth-gated `MediaController` (бакет остаётся PRIVATE, не публичный). Окружения разделяются **отдельными бакетами** (`FILE_STORAGE_BUCKET` per-env: prod → `balam-media`, dev/прочие → `balam-media-dev`). Ключ внутри бакета — `<kg_id>/…` (и `<kg_id>/stories/…`). Env-switch: `FILE_STORAGE_PROVIDER=local\|s3\|yandex` (default `local`). |

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

### 2.4 BCC payment data boundaries

- `bcc_merchant_accounts` — tenant-scoped + `FORCE ROW LEVEL SECURITY`. Обычный runtime-код читает account только в pinned tenant; provisioning выполняет super-admin, а входящий callback использует отдельный минимальный bypass-RLS lookup только по SHA-256 hash случайного callback token.
- Итоговый BCC MAC key хранится только в AES-256-GCM ciphertext через `CryptoCipherPort`. Две исходные key components XOR'ятся в памяти и не сохраняются. Callback password хранится только как bcrypt hash. Callback token дополнительно хранится как AES-GCM ciphertext только для построения server-owned `NOTIFY_URL`; plaintext возвращается лишь при создании/ротации и никогда через GET.
- `user_payment_profiles` — provider-neutral private row, глобальный по `user_id`, потому что parent JWT может обслуживать детей из разных tenant. Таблица без tenant RLS; repository API owner-scoped и не экспортируется в admin/super-admin listing. `billing_phone` не является `users.phone`.
- PAN, expiry и CVC никогда не проходят через Shyraq API, БД или логи. Их ввод разрешён только на hosted BCC page внутри WebView.
- Checkout state не хранится в таблице: random token и payment→token reverse key лежат в Redis с TTL 900 секунд. Атомарное consume (`GETDEL` либо Lua-equivalent) гарантирует one-time semantics; reverse key позволяет идемпотентному повтору `/pay` вернуть тот же URL пока session жива. Значения не логируются.

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

`users`, `saas_users`, `saas_refresh_tokens` — глобальные, RLS не накладывается.

`refresh_tokens` (`kindergarten_id` nullable) — **fizycznie tenant-scoped**: таблица имеет `FORCE ROW LEVEL SECURITY` + policy `tenant_isolation` (см. миграцию `1777593601000-AuthAndUsersTables`, строка 110). Однако три репо-метода `RefreshTokenRelationalRepository.{create, rotate, revokeAllByUserId}` сознательно обходят RLS через `SET LOCAL app.bypass_rls='true'` потому что:

- `create` / `rotate` вызываются из публичных эндпоинтов (`/auth/otp/verify`, `/auth/refresh`), которые не проходят через `KindergartenScopeGuard` — у запроса нет `kindergarten_id`, к которому RLS могла бы прикрепить.
- `revokeAllByUserId` вызывается из `/auth/logout` "logout-from-all-sessions" path и должен попасть в строки **всех** kindergartens, где у пользователя есть активные сессии. Без bypass RLS отфильтрует UPDATE до строки в kg-A (caller's tenant), оставив kg-B сессию активной — реальный session leak для multi-kg пользователей.

`revokeAllByUserId` использует **fresh-connection sub-transaction** (`this.repo.manager.transaction(...)`), а не savepoint в ambient TX (`outerManager.transaction(...)`). PostgreSQL `RELEASE SAVEPOINT` не сбрасывает GUC, поэтому `SET LOCAL app.bypass_rls='true'` в savepoint утёк бы в остаток request-TX. Trade-off: revoke commit'ится независимо от outer HTTP TX — если controller бросит ошибку после revoke, отмена не откатится. Для logout это желаемое поведение (partial-revoked > partial-keep).

Для остальных read-методов (`hasActiveSessionForDevice`, `revokeByHash`) RLS пропускает строки естественно — owner `user_id` + ambient `app.kindergarten_id` совпадают.

Изоляция в любом случае защищена на уровне сервиса (явные `kindergarten_id` + `user_id` фильтры в repo-методах).

### 3.6 B8 manual attendance flow

**Atomic 3-table TX (check-in / check-out):**
Один check-in или check-out записывает три строки внутри одной транзакции: `attendance_events` (основная запись события) + `timeline_entries` (human-readable запись в дневнике ребёнка) + upsert `child_daily_status` (агрегированный статус за день). Транзакция опирается на ambient EntityManager из `TenantContextInterceptor` (паттерн B5/B7 — без ручного `dataSource.transaction`). Сбой любой из трёх операций откатывает всё.

**`NotificationPort` расширение (B8):**
Добавлены 4 новых метода: `notifyAttendanceCheckIn`, `notifyAttendanceCheckOut`, `notifyDailyStatusChanged`, `notifyTimelineEntryCreated`. `LoggingNotificationAdapter` логирует все 4. Реальный WS/push-fanout — B9 (каждый метод адаптера помечен `// TODO(B9): WS fanout`).

**Pickup validation policy (B8 manual):**
`pickup_user_id` на check-out должен ссылаться на одобренного guardian'а ребёнка с `can_pickup=true` И `revoked_at IS NULL` (lookup в `child_guardians WHERE child_id=$ AND user_id=$ AND status='approved' AND revoked_at IS NULL AND can_pickup=true`). OTP-based pickup-by-trusted-person — B11; колонка `pickup_request_id` остаётся nullable в B8 и не пишется.

**Pickup OTP extension (B11):**
`attendance_method='otp_pickup'` (ENUM value добавлен в B11 миграции через `ALTER TYPE attendance_method ADD VALUE 'otp_pickup'`). При `method='otp_pickup'`: `pickup_user_id=null` (trusted person — не user-entity), `pickup_request_id` ссылается на validated `pickup_requests` row. `AttendanceService.checkOut` принимает опциональный `pickupRequestId`; при его наличии и `status='validated'` — пропускает стандартную `findApprovedActivePickupGuardian` проверку (trusted person не guardian). Атомарная TX: `attendance_events` + `timeline_entries` + `child_daily_status upsert` + update `pickup_requests.attendance_event_id`.

**Edit window (non-admin staff):**
`PATCH /staff/attendance/:eventId` разрешён только если `recorded_at::date == NOW()::date` в `Asia/Almaty`. Admin endpoint `/admin/attendance-events/:id` не имеет ограничения по окну. `// TODO(B22): make window configurable per kindergarten`.

**Daily status enum и defaults:**
`present | absent | sick | late | early_pickup | on_vacation` (default `absent`). Check-in делает upsert `child_daily_status.status='present'` только если текущий статус `absent` или `late` (либо строка отсутствует) — это сохраняет вручную установленные `sick` / `on_vacation`. Check-out не меняет `child_daily_status`.

**Out-of-scope для B8:**
WS/BullMQ (B9), QR-scan (B10), Pickup OTP (B11), Face ID (B19).

---

## 4. Auth & Identity

### 4.1 Tokens

- **Access token** — JWT HS256, TTL 15 мин (`AUTH_JWT_TOKEN_EXPIRES_IN`). Claims: `{ sub: userId, role, kindergarten_id?, jti, pending_role_select? }`.
- **Refresh token** — opaque random hex (32 байта = 64 hex), TTL 30 дней (`REFRESH_TOKEN_TTL_DAYS`). В клиенте — сырой токен; в БД (`refresh_tokens` / `saas_refresh_tokens`) — только `token_hash = SHA-256(raw)`. Ревокация — `UPDATE ... SET revoked_at = NOW()`.
- **Logout** — добавляет `jti` access-токена в `TokenBlocklistPort` (Redis с TTL до истечения JWT) + revoke текущего refresh-токена.

### 4.2 Identity QR

- **Token format** — 32-char opaque hex (`crypto.randomBytes(16).toString('hex')`). Не JWT, не UUID.
- **Storage** — SHA-256 hash в `user_qr_tokens.token_hash` (varchar 64, unique). Plaintext хранится только в Redis. Две парные записи: `qr:token:{plaintext} → user_id` (для O(1) валидации сканов) и `qr:user:{userId}:identity → plaintext` (для recover активного plaintext'а на повторном GET — без неё сервер не смог бы переиспользовать токен, потому что DB хранит только хэш). Обе с TTL = remaining lifetime.
- **Lifetime** — 24h. Reuse-or-mint на `GET /users/me/qr`: если активный токен есть и `expires_at - now > 1h` → возвращает тот же plaintext из `qr:user:{userId}:identity`; иначе атомарная TX (revoke old + insert new) + sync обеих Redis-записей. Каждый issueOrRefresh начинается с `pg_advisory_xact_lock(hashtext('qr:identity:'||user_id))` — сериализует concurrent GET'ы по user-id, чтобы избежать гонки на partial unique idx `(user_id, purpose) WHERE revoked_at IS NULL`. Ручного refresh-endpoint'а нет.
- **Lazy-issue** — токен не создаётся при login; первый `GET /users/me/qr` trigger'ит issue.
- **Cross-tenant** — `kindergarten_id` nullable, RLS не применяется к `user_qr_tokens`. Один QR на пользователя независимо от числа садиков.
- **Rate-limit на `/staff/qr/scan`** — 60/мин per `device_id` (берётся из активной `refresh_tokens` сессии вызывающего staff). Redis: `rl:qr:scan:{device_id}` через `INCR` + `EXPIRE 60`.
- **Admin revoke-all** — `POST /admin/qr/revoke-all/:userId`: bulk `UPDATE user_qr_tokens SET revoked_at = NOW() WHERE user_id = :userId AND revoked_at IS NULL` + `DEL qr:user:{userId}:identity` (next user GET сразу mintsит fresh). Plaintext-keyed `qr:token:{plaintext}` не удаляется — admin имеет только хэш; `scan`-side DB-recheck всё равно ловит revoked. Tenant-scoping: target user должен быть staff в kg вызывающего админа ИЛИ approved guardian ребёнка из этой kg, иначе 403 `user_no_relationship_to_kindergarten`. Response `{revoked_count}`.

Паттерн хранения (`token_hash` в БД + plaintext только в Redis) аналогичен `refresh_tokens` (см. §4.1).

### 4.3 OTP flow

`POST /auth/otp/request` → `OtpStorePort.create(phone, code, ttl)` (Redis-hash с attempts=0). SMS-отправка через `SmsPort` (mock логирует код). `TEST_PHONES` whitelist — bypass real SMS, возвращает `OTP_TEST_CODE` для test-сценариев.

`POST /auth/otp/verify` → `OtpStorePort.verify(phone, code)`:
- При несоответствии — `incrementAttempts()` (EXISTS pre-check защищает от TTL-edge: naked HINCRBY на expired hash создал бы запись с attempts=1 и обнулил lockout).
- 3 неудачных попытки — `lock(phone, lockTtl)`.

При успехе — issue access + refresh пары. Multi-role staff (≥2 active `staff_members`) получает временный access JWT с `pending_role_select: true` (без `kindergarten_id`); refresh не выдаётся до выбора. `POST /auth/role/select` принимает `kindergarten_id`, проверяет активную роль, выдаёт полную пару, добавляет временный JTI в blocklist.

**Auto-approve primary guardian (B6):** до ролевого резолва `AuthService.autoApprovePendingPrimaries(userId, now)` делает cross-tenant lookup `ChildGuardianRepository.findPendingPrimaryByUserIdCrossTenant(userId)` с `bypass_rls=true` внутри `dataSource.transaction`. Для каждой найденной `child_guardians (role='primary', status='pending_approval')` открывает scoped tx с `SET LOCAL app.kindergarten_id = childKgId` и переводит строку в `approved` (`approved_by=self`, `has_approval_rights=true`). Это обеспечивает кейс enrollment → родитель входит по OTP → JWT уже содержит kg-scope без ручного approve.

### 4.4 SuperAdmin auth

Email + password (`saas_users` table). `POST /super-admin/auth/login` → bcrypt verify → access + refresh (`saas_refresh_tokens`). Отдельная таблица — никакого полиморфизма с `users.refresh_tokens`.

### 4.5 Guards summary

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

**B9 (Notifications + WebSocket)** — реализован в двух процессах: `api` + `worker`. Standalone `ws`-процесс отложен до B22.

| Процесс | Entry | Статус | Назначение |
|---|---|---|---|
| **api** | `src/main.ts` | Существует с B1 | REST endpoints + **WS gateway collocated** (socket.io в том же event-loop). Payment-webhook receivers (ack 200 + enqueue в BullMQ). |
| **worker** | `src/main.worker.ts` | Введён в B9 | BullMQ consumers + repeatable jobs: `notification-outbox-poll` (каждые 2с), `weekly-rollout` (мигрирует с `@nestjs/schedule` на BullMQ), billing-cron, FCM/APNS, OFD-fiscalization, schedule/menu auto-copy, story TTL cleanup, identity-QR rotation (future batches). |
| **ws** | `src/main.ws.ts` | Deferred → B22 | Отдельный WebSocket процесс (нужен при ≥1000 concurrent sockets). До B22 — WS collocated в `api`. |

Все процессы делят один Postgres + один Redis. Communication: `api → worker` через BullMQ; `worker → api WS` через Redis Pub/Sub (`@socket.io/redis-adapter`) для broadcast'а.

**Почему WS collocated в api (до B22):** один Redis Pub/Sub, один JWT-secret, один `ChildGuardianRepository`. Отдельный процесс даст 0 выигрыша до ~1000 concurrent sockets. `@socket.io/redis-adapter` уже обеспечивает fanout через Redis Pub/Sub между любым числом api-инстансов.

Не разделяется в отдельные сервисы:
- **admin/parent/super-admin** — same code, same DB. Network-сегментация делается на reverse proxy (`/super-admin/*` за IP-allowlist/VPN).
- **auth** — JWT stateless, отдельный сервис плодит сетевой hop без выгоды при HS256.
- **scheduler** — внутри `worker` как BullMQ repeatable jobs.
- **payment-webhook receiver** — внутри `api`.

### 6.2 BullMQ queue/job catalog

| Queue / Job | Процесс | Интервал / Trigger | Назначение |
|---|---|---|---|
| `notification-outbox-poll` | worker (repeatable) | каждые 2с | Забирает `pending` строки из `notification_outbox`, fan-out'ит через `NotificationDispatcher`, помечает `dispatched`/`failed` |
| `notifications-outbox-prune` | worker (repeatable) | `0 4 * * 0` Asia/Almaty (вс 04:00) | B22b T12: weekly prune `notification_outbox` — DELETE rows `status='dispatched' AND created_at < now - 7d`, плюс `status='failed' AND created_at < now - 30d`. Cross-tenant, бежит под `app.bypass_rls='true'`. Retention hardcoded (NOT env-driven — GDPR/compliance trigger перепишет процессор когда придёт время). Idempotent: повторный tick на тот же `now` удаляет 0 строк. Partial индексы `idx_outbox_dispatched_created_at` + `idx_outbox_failed_created_at` обеспечивают index-only DELETE. Gated `OUTBOX_PRUNE_CRON !== 'disabled'`. |
| `weekly-rollout` | worker (repeatable) | раз в неделю (Пн 00:00 kg-TZ) | Авто-копирование расписания/меню на следующую неделю |
| (future) `billing-cron` | worker | ежесуточно | Биллинг, OFD-fiscalization — B14+ |
| `birthday-generation` | worker (repeatable) | `0 7 * * *` Asia/Almaty | B17: создаёт `content_posts` (type='birthday') для именинников, идемпотентно |
| `story-cleanup` | worker (repeatable) | ежечасно | B17: удаляет истёкшие `group_stories` (`expires_at <= NOW()`), вызывает `FileStoragePort.delete` |
| `content-publish` | worker (repeatable) | каждые 5 минут | B17: условный UPDATE `content_posts` `scheduled → published` для `scheduled_for <= NOW()` |
| `lifecycle` / `lifecycle:pro-rata-refund` | worker (on-demand) | Triggered by archive action | B21: ProRataRefundProcessor — рассчитывает pro-rata refund при архивировании ребёнка посреди billing-period. Payload: `{kindergartenId, childId, archivedAt}`. Idempotency: `pg_advisory_xact_lock(hashtext('pro-rata:'||childId))` + existing-refund check. Retry: exp-backoff 3×(1m, 2m, 4m). Создаёт `refunds(status='pending', reason='pro_rata_archive')`. File: `src/modules/billing/infrastructure/processors/pro-rata-refund.processor.ts`. Queue registered via `BullModule.registerQueue({ name: 'lifecycle' })`. |
| `bcc-payment-reconciliation` | worker (delayed jobs) | первый check через 5 мин, затем bounded backoff | `TRTYPE=90` только для BCC payments в `processing`. Повторы прекращаются при terminal state либо возрасте 24h; после 24h выставляется `manual_review_required_at`, но не `failed`. Late success использует общий settlement service. |

`@nestjs/schedule` удаляется в B9 (заменён BullMQ). BullMQ даёт бесплатный distributed lock через Redis `BZPOPMIN` — только один worker-инстанс выполняет job в момент времени.

### 6.3 Outbox event lifecycle

Паттерн Transactional Outbox (D17) заменяет небезопасный `Promise.resolve().then(notify)` из B5–B8.

```
Business TX
  ├─ INSERT/UPDATE бизнес-данные (attendance_events, timeline_entries, …)
  └─ INSERT notification_outbox (status='pending', event_key, payload)
       ← та же TypeORM transaction, тот же EntityManager

Worker (каждые 2с)
  └─ SELECT … FROM notification_outbox
       WHERE status='pending' AND next_retry_at <= NOW()
       FOR UPDATE SKIP LOCKED          ← конкурентная безопасность
  └─ NotificationDispatcher.handle(event)
       ├─ resolve recipients (ChildGuardianRepository / GroupMentorRepository)
       ├─ apply notification_preferences filter
       ├─ apply nanny-policy (nanny получает только attendance.* и pickup.*)
       ├─ PushNotificationPort.send(…)  ← MockPushAdapter (dev) | FcmPushAdapter (firebase-admin), env PUSH_PROVIDER
       ├─ WS broadcast в room (через Redis Pub/Sub → api WS gateway)
       └─ INSERT notifications (history row, status='sent')
  └─ UPDATE notification_outbox SET status='dispatched'/'failed', attempts=attempts+1
       ← exponential backoff на failed: next_retry_at = NOW() + 2^attempts * interval
```

Таблица `notification_outbox` описана в `schema.dbml`. RLS-scoped по `kindergarten_id`.

### 6.4 WebSocket room catalog

Подключение: `wss://host/ws`, JWT передаётся в `socket.handshake.auth.token` (не в query — query параметры попадают в access-логи).

`NotificationGateway.handleConnection` верифицирует JWT через `JwtTokenPort` + `TokenBlocklistPort`. При ошибке — эмитит `auth_error` (`{ message: 'unauthorized' }`) и отключает сокет. (`connect_error` в socket.io v4 зарезервирован для middleware-уровня; с сервера не эмитируется.)

**Long-lived session safety (F15 fix)** — handshake-only auth не закрывает три сценария: (1) logout, (2) истечение access-token TTL, (3) admin revoke. Гейтвей реализует две защиты:

- **Layer A — per-socket TTL.** На успешном connect шедулится `setTimeout(payload.exp * 1000 - Date.now())` (cap 24h sanity bound). При срабатывании эмитит `auth_error` (`{ message: 'token_expired' }`) + `disconnect(true)`. На reconnect с новым токеном — новый таймер. Очищается в `handleDisconnect`.
- **Layer B — blocklist propagation.** `RedisTokenBlocklistAdapter.blocklist()` после SET делает `PUBLISH token:blocklist:events <jti>`. Каждый api-процесс держит отдельный subscriber-клиент через `TokenBlocklistEventsPort` (`WsBlocklistListenerService` в `src/websocket/`). На входящее событие — гейтвей по in-process индексу `Map<jti, Set<Socket>>` находит локальные сокеты и шлёт им `auth_error` (`{ message: 'session_revoked' }`) + `disconnect(true)`. Pub/sub фанит на все api-реплики; worker-процесс не подписан (нет сокетов).

После успешной аутентификации `WsAutoSubscribeService` подписывает сокет на комнаты согласно `role` + `kindergarten_id` из JWT:

| Комната | Триггер | DB-запрос |
|---|---|---|
| `user:{user_id}` | Всегда (каждый connected сокет) | — |
| `child:{child_id}` | `role='parent'` + непустой `kindergarten_id` в JWT | `SELECT child_id FROM child_guardians WHERE user_id=? AND status='approved' AND revoked_at IS NULL AND kindergarten_id=?` |
| `group:{group_id}` | `role` ∈ staff-ролей + непустой `kindergarten_id` в JWT | `SELECT group_id FROM group_mentors WHERE user_id=? AND is_active=true AND kindergarten_id=?` |

`super_admin` и `pending_role_select=true` — только `user:{id}`; kg-scoped комнаты не назначаются. Комнаты определяются строго по JWT в момент handshake — cross-tenant связи в других kg не включаются. Переподписка — при reconnect с новым JWT.

Сервер эмитит `connected` событие: `{ user_id, rooms: [...] }` — клиент может использовать это для подтверждения подписки перед тем как считать себя "online".

**Broadcast format (B9):** `NotificationDispatcher` вызывает `wsBroadcaster.broadcastToUser(userId, event_key, payload)` — envelope-обёртки нет. Клиент получает событие под именем `event_key` (например, `attendance.checkin`), payload — rendered-шаблон + денормализованные поля (`title_i18n`, `body_i18n`, `data`).

Диспетчер бродкастит в `user:{userId}` комнаты для всех событий, соблюдая персональные `notification_preferences.in_app_enabled` по каждому ключу.

**BR-016 — WS group-fanout (Core 6, активен):** для шести событий — `attendance.checkin`, `attendance.checkout`, `daily_status.changed`, `timeline.entry_created`, `content.story_new`, `content.news_published` (только ветка `targetType=group`) — диспетчер дополнительно вызывает `broadcastToGroup(groupId, event_key, payload)` в комнату `group:{groupId}`, где сидят воспитатели группы (auto-subscribe через `group_mentors`). Это room-level signal «обнови экран» — он срабатывает **всегда** (вне блока `if (inAppUsers.length>0)`), независимо от per-user `in_app`-prefs; персональные `user:`-рассылки prefs соблюдают как прежде. `group_id` для child-событий (`attendance.*`/`daily_status.changed`/`timeline.entry_created`) резолвится лениво из `children.current_group_id` (`childRepo.findById`); для `content.story_new`/`content.news_published` — из recipient-резолвера. В груп-конверте `data` дополнительно несёт `groupId` (+`childId` где есть) для точечной инвалидации кэша. Если группа не резолвится (ребёнок без `current_group_id`, либо `content.news_published` с `targetType` ∈ {`all`,`child`}) — груп-emit пропускается. `diagnostic.new` / `progress_note.new` в набор **не входят** (приватность специалистских данных — комната `group:` для воспитателей, не специалистов). Порт `broadcastToChild` реализован, но в диспетчере пока не вызывается. Комнаты `child:*`/`group:*` заполняются при handshake.

### 6.5 Notification event catalog

Полный список `event_key`-ов, выводимых `NotificationPort` (методы в `src/common/notifications/notification.port.ts`):

| event_key | NotificationPort метод | Комнаты | Адресаты |
|---|---|---|---|
| `attendance.checkin` | `notifyAttendanceCheckIn` | `child:{childId}` | approved guardians ребёнка |
| `attendance.checkout` | `notifyAttendanceCheckOut` | `child:{childId}` | approved guardians ребёнка |
| `daily_status.changed` | `notifyDailyStatusChanged` | `child:{childId}` | approved guardians ребёнка |
| `timeline.entry_created` | `notifyTimelineEntryCreated` | `child:{childId}` | approved guardians ребёнка |
| `guardian.pending_approval` | `notifyGuardianPendingApproval` | `user:{primaryUserId}` | primary guardian ребёнка |
| `guardian.approved` | `notifyGuardianApproved` | `user:{guardianUserId}` | новый guardian |
| `guardian.rejected` | `notifyGuardianRejected` | `user:{guardianUserId}` | отклонённый guardian |
| `guardian.revoked` | `notifyGuardianRevoked` | `user:{guardianUserId}` | удалённый guardian |
| `child.transferred` | `notifyChildTransferred` | `user:{recipientUserIds[]}` | все approved guardians (переданные явно) |
| `guardian.permissions_updated` | `notifyPermissionsUpdated` | `user:{guardianUserId}` | затронутый guardian |
| `pickup.otp_sent` | `notifyPickupOtpSent` | `user:{requesterId}` | инициатор pickup_request; SMS на `trusted_person_phone` отправляется напрямую через `SmsPort` (не через outbox-fanout на trusted person — у них нет user-записи); запись в `notification_outbox` для аудита и push инициатору. **B11 — implemented.** |
| `pickup.validated` | `notifyPickupValidated` | `child:{childId}` | все approved guardians ребёнка + requester (`requested_by_user_id`). Nanny-policy: nanny получает `pickup.*`. **B11 — implemented.** |

**B12 — planned (not yet implemented):**

| event_key | Адресаты | Комнаты |
|---|---|---|
| `request.accepted` | requester (parent, `requester_user_id`) | `user:{requesterId}` |
| `request.rejected` | requester (parent, `requester_user_id`) | `user:{requesterId}` |
| `request.cancelled` | recipient staff (если `recipient_staff_id` назначен) | `user:{recipientStaffUserId}` |
| `request.message_sent` | если автор parent → `recipient_staff_id` + admin'ы; если автор staff → requester | `user:{...}` |

Nanny-policy: nanny НЕ получает `request.*` — только `attendance.*` и `pickup.*`. Impl добавляется в T3 (B12).

**B17 — Content & Stories (реализуется в B17 T3):**

| event_key | NotificationPort метод | Адресаты | Примечание |
|---|---|---|---|
| `content.news_published` | `notifyContentNewsPublished` | guardians по `target_type`: `all` → все дети kg; `group` → дети группы; `child` → ребёнок | Nanny НЕ получает |
| `content.story_new` | `notifyContentStoryNew` | guardians детей группы | Nanny НЕ получает |
| `content.qundylyq_new` | `notifyContentQundylyqNew` | все guardians детей kg | Nanny НЕ получает |
| `content.birthday` | `notifyContentBirthday` | guardians именинника (`target_child_id`) | Nanny НЕ получает |

Event keys зарезервированы в `src/modules/notification/event-keys.ts` (lines 27-30). Методы `NotificationPort` — default-no-op concrete methods (backward-compat с существующими test fakes). `OutboxNotificationAdapter` override'ит все 4 метода.

Будущие event-ключи (добавляются по мере батчей): `payment.upcoming`, `payment.overdue`, `payment.receipt_issued` (B14), `face.enrolled` (B19).

**Nanny-policy:** guardian с `role='nanny'` получает только `attendance.*` и `pickup.*` — остальные ключи (`request.*`, `payment.*`, etc.) отбрасываются в `NotificationDispatcher` до send.

### 6.6 BCC checkout, callback and settlement

```text
Parent /pay
  → active tenant BCC account
  → payment(processing) + Redis checkout token (15 min)
  → Shyraq bridge in WebView
  → POST signed form + M_INFO to BCC hosted page
  → BACKREF closes WebView and shows processing

BCC NOTIFY callback ─┐
                     ├→ one idempotent settlement service → payment/invoice/outbox
TRTYPE=90 worker ────┘
```

`BACKREF` is UX navigation, never a payment verdict. The mobile client intercepts the configured HTTPS URL; later it may become an app Universal Link/App Link. Success/failure is accepted only from an authenticated, validated callback or reconciliation response.

The bridge is an API-process route because it must atomically consume Redis state and render a short-lived form. It returns `Cache-Control: no-store`, strict CSP and escaped dynamic values, then browser JS adds screen dimensions to Base64 `M_INFO`. Billing phone/address were confirmed before initiation and are included only in `M_INFO`.

Callback routing is account-first, not tenant-from-request: `callbackToken` hash identifies exactly one merchant account under a narrowly scoped bypass, then the service pins that account's `kindergarten_id` before touching payment/invoice rows. Basic Auth, terminal/merchant/order/amount checks precede settlement. Exact BCC callback signature/ACK/retry details remain a Gate F protocol question and must be confirmed before declaring the endpoint production-ready.

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
