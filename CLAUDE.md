# CLAUDE.md — Balam Backend 

Onboarding для будущих Claude-сессий в этом репо. Read before editing anything.

**Сначала прочитай [`MEMORY.md`](MEMORY.md)** — там проектный контекст и архитектура: §1 Project, §2 Stack, §3 Sources of truth, §4 Module layout, §5 Multi-tenancy, §6 Local setup. Этот файл — actionable-правила и конвенции, §7–§11.

**Нумерация секций сквозная** через оба файла (§1–§6 → MEMORY.md, §7–§11 → здесь), поэтому существующие ссылки `CLAUDE.md §N` в коде не ломаются по номеру. Ссылки на §3–§6 теперь резолвятся в MEMORY.md.

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
3. Создать структуру `src/modules/<x>/` по template из [`MEMORY.md §4`](MEMORY.md).
4. `domain/entities/<x>.entity.ts` — POJO с инвариантами + `toState()/fromState()`.
5. TypeORM-entity в `infrastructure/persistence/relational/entities/`. Mapper в `mappers/`.
6. `<x>.repository.ts` (abstract) + `<X>RelationalRepository`.
7. `<x>.service.ts` (бизнес-логика) + `<x>.service.spec.ts` (с in-memory fakes).
8. `<x>.controller.ts` + DTO с полным Swagger.
9. `<x>.module.ts` — DI wiring, `TypeOrmModule.forFeature([...])`, port↔adapter.
10. Зарегистрировать в `app.module.ts`.
11. E2E: cross-tenant phantom-row integration spec (kg_A vs kg_B), `test/<x>.e2e-spec.ts` через HTTP.

## 10. Do not

- Не создавать файлы вне SoT-таблицы (MEMORY.md §3) без подтверждения.
- Не вводить use-case классы или CQRS-обвязку — service.ts достаточно.
- Не упоминать `prisma` нигде в коде/комментариях.
- Не мокать БД или Redis в integration-тестах.
- Не обходить RLS через прямой `DATABASE_USERNAME=shyraq` (superuser) в runtime — изоляция не сработает.
- Не пропускать husky pre-commit — fix issue + re-commit.
- Amend / force-push без явного запроса.

## 11. Pointers

- [`MEMORY.md`](MEMORY.md) — проектный контекст + архитектура (§1–§6)
- [`docs/architecture.md`](docs/architecture.md) — техническая архитектура
- [`docs/endpoints.md`](docs/endpoints.md) — REST/WS контракты
- [`docs/schema.dbml`](docs/schema.dbml) — DB модель (human-readable)
- [`docs/Shyraq BP.md`](docs/Shyraq%20BP.md) — бизнес-процессы
- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — батч-план + прогресс
- `src/database/migrations/` — DB SoT (TypeORM миграции)
- `env-example-relational` — все env-переменные с дефолтами и комментариями
