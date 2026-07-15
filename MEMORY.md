# MEMORY.md — Balam Backend (project knowledge)

Фактический контекст и архитектура проекта. Companion к [`CLAUDE.md`](CLAUDE.md), где живут actionable-правила (§7 Testing → §11 Pointers).

**Единая сквозная нумерация секций:** §1–§6 здесь, §7–§11 в CLAUDE.md. Поэтому ссылки `CLAUDE.md §N` в коде, где `N ∈ {7..11}`, валидны как есть; ссылки на §3–§6 теперь резолвятся в этот файл.

> Не путать с приватной auto-memory Claude (`~/.claude/.../memory/MEMORY.md`) — это checked-in проектный документ. И в отличие от CLAUDE.md он **не** авто-грузится в контекст сессии — читай его первым вручную.

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
- runtime app role (NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE) — имя и пароль берутся из `DATABASE_USERNAME` / `DATABASE_PASSWORD` (например `balam_app` в dev). Создаётся `InitExtensions` миграцией из этих env (не хардкод — имя валидируется как идентификатор, пароль экранируется).

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

# 4. Bootstrap super_admin в saas_users (иначе Admin Web login не с чем сверять).
#    Идемпотентно; берёт SUPER_ADMIN_SEED_EMAIL/PASSWORD из .env.
npm run seed:super-admin

# 5. App (под shyraq_app)
npm run start:dev
# → http://localhost:3000/docs (Swagger)
# → /api/v1/...
```

Migrations создаются: `npm run migration:create -- src/database/migrations/<Name>` или auto-generate из entity diff: `npm run migration:generate -- src/database/migrations/<Name>`. Обе команды принимают **позиционный путь** — флага `--name` у TypeORM CLI 0.3 нет.

`saas_users` пустая после миграций — `npm run seed:super-admin` (`src/database/seeds/seed-super-admin.ts`) идемпотентно upsert'ит супер-админа из `SUPER_ADMIN_SEED_*`. Запускать на каждом деплое после миграций.

### Docker (dev / prod)

Полный стек одной командой. Base = `docker-compose.yml` (redis + api + worker), оверрайды добавляют режим:

```bash
npm run docker:dev:up     # postgres + redis + api + worker; env_file .env.development; API :5678, PG :55432
npm run docker:prod:up    # redis + api + worker; PostgreSQL — MANAGED (внешний); env_file .env.production; API :3000
npm run docker:dev:down / docker:prod:down      # остановить
npm run docker:dev:logs  / docker:prod:logs     # логи -f
```

- Контейнер `api` на старте сам гонит `db:migrate` → `db:seed` → `start:prod`. `db:migrate`/`db:seed` — **без `env-cmd`** (он перезаписал бы docker-env запечённым `.env`); используют `process.env` из `env_file`.
- **prod**: postgres-контейнера нет — `DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_SSL_ENABLED` в `.env.production` указывают на managed-БД. Migration-роль managed-БД должна иметь `CREATEROLE` (InitExtensions создаёт `*_app` роль + RLS).
- Реальные `.env.*` исключены из образа (`.dockerignore`) — секреты не запекаются; env приходит через `env_file` в рантайме.

---

Actionable-правила, конвенции тестирования и процедуры — в [`CLAUDE.md`](CLAUDE.md) (§7 Testing → §11 Pointers).
