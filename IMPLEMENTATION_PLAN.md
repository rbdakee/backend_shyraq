# Shyraq Backend v2 — Implementation Plan

> Source-of-truth для порядка реализации. Прогресс отмечается галочками сразу при завершении sub-task'а.

---

## 0. v2 baseline (P0–P5 + B5–B6 complete)

Репо `backend_shyraq_v2` — TypeORM + service.ts brocoders pattern. Достиг **B4-parity** на коммите `f1d6984` (P5 children & guardians).

| Фаза | Что сделано |
|---|---|
| **P0** Bootstrap | clone brocoders skeleton, удалено social/mail/files/sessions/roles/statuses/mongo/hygen |
| **P1** Foundation | shared-kernel (43 файла), `tenant-storage.ts` (AsyncLocalStorage), health module, initial migration с pgcrypto + uuid-ossp, eslint config настроен |
| **P2** Auth & Users | domain layer (3 entities + 11 errors), 5 TypeORM entities, миграция AuthAndUsersTables с RLS на `kindergartens` + `refresh_tokens`. Ports & adapters: SmsPort/MockSmsAdapter, JwtTokenPort/JsonwebtokenAdapter, PasswordHasherPort/BcryptPasswordHasher, OtpStorePort/RedisOtpStore, TokenBlocklistPort/RedisTokenBlocklist. Repos + mappers + TenantContextInterceptor + 4 guards + 5 decorators. AuthService (8 methods) + UsersService + 3 controllers. Two DB roles (`shyraq` superuser owns DDL; `shyraq_app` non-owner runs app); FORCE ROW LEVEL SECURITY включён. |
| **P3** Tenant Bootstrap | KindergartenModule (createKindergarten + first admin atomic TX, updateSettings, getMyKindergarten, inviteAdmin, listKindergartens, archive, restore). Минимальный StaffMember entity для admin seed. Миграция StaffAndKindergartenSettings. Cross-tenant phantom-row integration spec. |
| **P4** Organization | StaffService extended, GroupModule (rich aggregate с `assignMentor` инвариантом — partial-unique idx `idx_group_mentors_one_active WHERE unassigned_at IS NULL`), LocationModule, CameraModule. Миграция OrganizationTables. E2E объединены в один `organization.e2e-spec.ts`. |
| **P5** Children & Guardians | Child + ChildGuardian + child-group-history domain entities, 11 errors, миграция ChildrenAndGuardians (3 tables, FORCE RLS, partial-uniques `(child_id, user_id) WHERE status<>'revoked'` и `(kindergarten_id, iin) WHERE iin IS NOT NULL`, status/gender CHECK). ChildService ~700 строк (19 методов). ChildAccessGuard для admin/parent scope. NotificationPort + LoggingNotificationAdapter в SharedKernelModule. Контроллеры: child (admin), parent-child (read-only), parent-approval (state-machine + permissions). |
| **B5** Enrollment | EnrollmentModule (domain + persistence + service + controller + DTO + presenter), migration EnrollmentTables (2 tables + ENUM + FORCE RLS). State machine: new→in_processing→{waitlist\|card_created\|cancelled}, waitlist→in_processing, card_created→archive, cancelled→archive. transition→card_created reuses ChildService.createChild + inviteGuardian atomically via ambient TX. `src/shared-kernel/domain/errors/conflict.error.ts` base + DomainErrorFilter `ConflictError → 409` ветка. Tests: unit 42/412, integration 50/439, e2e 8/65. Swagger `/api/v1/admin/enrollments`. |
| **B6** Parent Onboarding | `POST /parent/children/link` (cross-tenant IIN search, creates pending guardian secondary\|nanny), `POST /parent/children/:id/unlink` (soft-revoke, 403 for primary). Auto-approve hook в `AuthService.verifyOtp` BEFORE assembleRoles via `ChildGuardianRepository.findPendingPrimaryByUserIdCrossTenant` (bypass_rls). 5 новых domain errors + shared-kernel `ForbiddenActionError` base (→ 403). DomainErrorFilter passes through `details` для `MultipleChildrenForIinError`. `ChildService` +155 строк (880 total). `parent-onboarding.e2e-spec.ts` 553 строки / 8 сценариев A–H. Нет новой миграции (схема P5 достаточна). Tests: unit 42/439, integration 52/473, e2e 9/73. |

**Текущее состояние (B6):** 42 unit suites / 439 tests green. Integration (INTEGRATION_DB=1): 52 suites / 473 tests. E2E: 9 suites / 73 tests. Endpoints под `/api/v1/...`. Swagger полный.

**Отличия v2 от старого репо:** TypeORM (не Prisma), `<x>.service.ts` per module (не CQRS use-case-классы), brocoders module layout с `domain/` + `dto/` + `infrastructure/persistence/relational/{entities,mappers,repositories}/` (не 4-слойный hexagonal `domain/application/infrastructure/interface`), RLS + явная передача `kindergarten_id` (не `prisma.$extends` ALS-only), FORCE ROW LEVEL SECURITY + два DB-role'а (`shyraq` superuser для миграций / `shyraq_app` non-owner для runtime).

**B5+ продолжается с этого baseline'а.**

---

## 1. Сквозные принципы (применяются в каждом батче)

1. **Docs-first.** Если батч добавляет endpoint/таблицу/event/queue — сначала обновляем соответствующий SoT-doc (по таблице в [`CLAUDE.md §3`](CLAUDE.md)), показываем diff, и только потом пишем код.
2. **Swagger-first.** Каждый endpoint получает `@ApiTags`, `@ApiOperation`, DTO с `@ApiProperty` + realistic `example`. Если в Swagger не виден — не считается сделанным.
3. **Multi-tenancy с первой строчки.** Каждый запрос идёт через `KindergartenScopeGuard` + `TenantContextInterceptor` (RLS GUC). Service.ts явно передаёт `kindergarten_id` в repo-вызовы. Cross-tenant phantom-row integration spec — обязательная часть каждой новой tenant-scoped таблицы.
4. **Тесты — часть батча, 4 уровня.** domain-unit (POJO/VO) + service-unit (in-memory fakes) + integration-spec (real PG/Redis, gated `INTEGRATION_DB=1`) + e2e (HTTP через Supertest).
5. **Никаких спекулятивных абстракций.** Базовые классы / generic helpers только когда есть 3+ повторений.
6. **External integrations через port/adapter.** `abstract class` + `MockAdapter` + `RealAdapter` (с TODO, если нет credentials). Switch через env (`PAYMENT_PROVIDER=mock|halyk`).
7. **Прогресс — в этом файле.** Каждый sub-task в чек-листе; отметка `[x]` ставится сразу при завершении.

---

## 2. Карта батчей (high-level)

| # | Батч | BP / тех-блок | Цель demo |
|---|---|---|---|
| ~~B0~~ | ~~Foundation~~ | — | replaced by P0–P1 |
| ~~B1~~ | ~~Auth & Identity~~ | — | replaced by P2 |
| ~~B1.5~~ | ~~Hexagonal Refactor~~ | — | n/a (v2 starts brocoders, not hexagonal) |
| ~~B2~~ | ~~Tenant Bootstrap~~ | — | replaced by P3 |
| ~~B3~~ | ~~Organization~~ | — | replaced by P4 |
| ~~B4~~ | ~~Children & Guardians~~ | — | replaced by P5 |
| **B5** | **Enrollment** | BP §1 целиком | Полный путь lead → in_processing → card_created → активный ребёнок. **Demo-ready!** |
| **B6** | **Parent Onboarding** | BP §2 целиком | Родитель заходит в приложение по OTP, привязывает ребёнка по ИИН, primary одобряет. **Demo-ready!** |
| **B7** | **Schedule & Meal** | BP §9 (часть) + ScheduleModule | Templates + slots + activity_events; meal_plans с auto-copy cron |
| **B8** | **Attendance & Timeline (manual)** | BP §5 без Face/QR | Manual check-in/out → timeline → daily_status → push родителю. **Demo-ready (BP §5 manual)!** |
| **B9** | **Notifications + WebSocket** | Shared §0.4 + WS gateway | Push + WS rooms, preferences (mute), notification history. Process split: api + worker + ws. |
| **B10** | **Identity QR** | BP §13 целиком | Refreshable QR в Parent/Staff app, scan endpoint, fallback при Face fail. **Demo-ready!** |
| **B11** | **Pickup OTP & Trusted** | BP §7 целиком | Whitelist, OTP по SMS, валидация, фиксация в attendance. **Demo-ready!** |
| **B12** | **Parent Requests** | BP §6 целиком | 5 типов заявок, статус-машина, тред сообщений. **Demo-ready!** |
| **B13** | **Billing & Invoices (mock provider)** | BP §4 (бэк-часть) | Тарифы, assignments, cron генерации invoice 1-го числа, pro-rata, holidays, MockPaymentProvider |
| **B14** | **Payment Provider — Halyk** | BP §4 (real money) | Подключение боевого Halyk ePay, webhook idempotency. **Demo-ready (полный BP §4 без OFD)!** |
| **B15** | **OFD (Fiscal)** | BP §4 add-on | Интеграция с одним из ОФД, retry, QR на чек. **Demo-ready (BP §4 целиком)!** |
| **B16** | **Custom Discounts** | BP §4.1 | Conditions engine, batch-notify, auto-apply на invoice. **Demo-ready (BP §4 расширенный)!** |
| **B17** | **Content & Stories** | BP §9 целиком | News, Qundylyq, birthday auto-gen, group stories 24h TTL, auto-copy menu/schedule. **Demo-ready!** |
| **B18** | **Diagnostics & Progress** | BP §8 целиком | Templates → entries → progress notes → видимость родителю. **Demo-ready!** |
| **B18.5** | **Edge Bootstrap** | архитектура (D15) — cloud↔edge protocol | edge-agent skeleton, pairing-flow, mTLS, `edge_commands` / `edge_health` / `kindergarten_edge_credentials` tables. Super-admin создаёт kindergarten → выдаёт pairing-token → mini-PC регистрируется → cloud видит «edge online» heartbeat. Блокирует B19/B20. |
| **B19** | **Face ID** | BP §5 (Face-часть) | Consent → enrollment → identification → check-in. **Demo-ready (BP §5 целиком)!** |
| **B20** | **CCTV** | BP §11 целиком | MediaMTX, Nginx auth_request, локальные edge-tokens, WS-trigger при смене локации. **Demo-ready!** |
| **B21** | **Lifecycle** | BP §12 целиком | Архивация, переводы между группами, смена ментора, пересчёт оплат. **Demo-ready!** |
| **B22** | **Polish** | i18n, validators, security headers, Swagger финал | Production-ready hardening |

**Параллелизация:** B7 ⊥ B8, B9 ⊥ B10, B17 ⊥ B18 — могут идти параллельно если есть руки. **B19 ⊥ B20** только после закрытия B18.5 (Edge Bootstrap) — оба батча зависят от уже работающего cloud↔edge канала и pairing'а.

---

## 3. Шаблон батча (B5+)

Перед стартом каждого батча:

1. **Doc-sync.** Какие из 4 SoT-doc'ов трогаем? Покажи diff пользователю, получи "ок".
2. **Migration.** Если новые таблицы/колонки — `npm run migration:create -- --name=<batch>`. RLS policy + `FORCE ROW LEVEL SECURITY` + indexes (включая partial-uniques) в той же миграции.
3. **Module skeleton.** Создать NestJS модуль по template из [`CLAUDE.md §4`](CLAUDE.md): `domain/` (entity/VO/error), `dto/`, `infrastructure/persistence/relational/{entities,mappers,repositories}/`, `<x>.repository.ts` (abstract), `<x>.service.ts`, `<x>.controller.ts`, `<x>.module.ts`. Зарегистрировать в `AppModule`.
4. **Endpoints с Swagger-аннотациями.** Каждый endpoint виден в `/docs`. DTO с `@ApiProperty({example})` + `@ApiResponse` 200/201/400/401/403/404/409/422/429.
5. **Multi-tenancy enforcement.** Service.ts явно передаёт `kindergartenId` в repo. RLS policy на новой таблице (см. §2 architecture.md). Cross-tenant phantom-row integration spec.
6. **Tests по 4 уровням.** domain-unit + service-unit (in-memory fakes) + integration-spec (real PG/Redis) + e2e (HTTP).
7. **Manual smoke.** Прогон через Swagger UI: ключевые BP-сценарии отрабатывают.
8. **Update progress.** Поставить `[x]`; если демо-ready — отметить в Demo-Ready секции.

---

## 4. Прогресс-трекер

> Маркер: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

### Foundation (replaced by P0–P5 in v2)

- [x] **P0** Bootstrap (commit `4998f81`)
- [x] **P1** Foundation (commit `018b07d`)
- [x] **P2** Auth (commits `cacb396` → `b9ea1f9` → `f8ad876` → `5b727b1` → `c87b689`)
- [x] **P3** Tenant Bootstrap (commit `0279633`)
- [x] **P4** Organization (commit `319e82f`)
- [x] **P5** Children & Guardians (commit `f1d6984`) — **B4-parity reached**

### BP-батчи (v2 продолжает с B5)

- [x] **B5** — Enrollment ✓ **demo-ready: BP §1**
- [x] **B6** — Parent Onboarding ✓ **demo-ready: BP §2**
- [ ] **B7** — Schedule & Meal *(часть BP §9)*
- [ ] **B8** — Attendance & Timeline (manual) ✓ **demo-ready: BP §5 manual**
- [ ] **B9** — Notifications + WebSocket *(Shared §0.4 + process split api/worker/ws)*
- [ ] **B10** — Identity QR ✓ **demo-ready: BP §13**
- [ ] **B11** — Pickup OTP & Trusted ✓ **demo-ready: BP §7**
- [ ] **B12** — Parent Requests ✓ **demo-ready: BP §6**
- [ ] **B13** — Billing & Invoices (mock provider)
- [ ] **B14** — Halyk ePay (real)
- [ ] **B15** — OFD ✓ **demo-ready: BP §4**
- [ ] **B16** — Custom Discounts ✓ **demo-ready: BP §4 расширенный**
- [ ] **B17** — Content & Stories ✓ **demo-ready: BP §9**
- [ ] **B18** — Diagnostics ✓ **demo-ready: BP §8**
- [ ] **B18.5** — Edge Bootstrap *(cloud↔edge protocol, pairing, mTLS — блокирует B19/B20)*
- [ ] **B19** — Face ID ✓ **demo-ready: BP §5 целиком**
- [ ] **B20** — CCTV ✓ **demo-ready: BP §11**
- [ ] **B21** — Lifecycle ✓ **demo-ready: BP §12**
- [ ] **B22** — Polish

### Demo-able BP

- [x] **BP §1** Enrollment & Onboarding *(часть — бутстрап tenant'а + первого admin'а закрыта в P3; enrollment детей — закрыта в B5: leads, state machine transition→card_created)*
- [x] **BP §2** Parent App Onboarding *(B6: link/unlink по ИИН + auto-approve primary на OTP verify — demo-ready)*
- [x] **BP §3** Staff & Admin Provisioning *(P3 + P4: первый admin — атомарный POST /super-admin/kindergartens; остальные staff — POST /admin/staff с role×specialist_type matrix, TX-атомарность create+mentor-assign, deactivate/activate symmetric, mentor assign/change-primary с partial-idx invariants)*
- [ ] **BP §4** Payments
- [ ] **BP §5** Daily Operations & Attendance
- [ ] **BP §6** Parent Requests
- [ ] **BP §7** Pickup & Trusted Person OTP
- [ ] **BP §8** Diagnostics & Progress
- [ ] **BP §9** Content Management
- [ ] **BP §10** Notifications & Parent Visibility *(закрывается в B9 + по ходу)*
- [ ] **BP §11** CCTV
- [ ] **BP §12** Lifecycle Management
- [ ] **BP §13** Identity QR System

---

## 5. Открытые вопросы

### Active

- **SMS-провайдер** (Kazakh local vs Twilio fallback) — блокирует production-launch. На время отсутствия real-provider mock допускается даже в `NODE_ENV=production`; start-up guard добавится PR'ом подключения real-provider.
- **OFD-провайдер** (Kassa24 / Rekassa / Webkassa) — блокирует запуск B15 в demo.
- **TipTopPay vs FreedomPay** — выбрать один. Блокирует расширение B14.
- **Qdrant vs pgvector** для face embeddings — блокирует начало B19. (D15 фиксирует Qdrant локально на edge; pgvector вариант снят с рассмотрения.)
- **IIN Luhn checksum validation** — валидируется только формат `^\d{12}$`. Контрольная цифра по алгоритму ИИН РК (Luhn-mod-вариант) откладывается до v2-polish.

### Resolved (исторические — full log в memory)

- **2026-04-30 · B6 · Parent Onboarding** — link/unlink endpoints implemented (`POST /parent/children/link`, `POST /parent/children/:id/unlink`), auto-approve primary в `verifyOtp` (defer from B5 — closed). Parent JWT scope (P5 leftover) — closed via `6b0a929` и exercised by Scenario A e2e. ForbiddenActionError base введён в shared-kernel; DomainErrorFilter now passes through `details` for clients (used by `multiple_children_for_iin`). No DB migration needed.

- **2026-04-30 · B5 · Enrollment** — invoice generation на `card_created` — defer на B13. Hook-point: `EnrollmentService.transition()` где помечен `// TODO(B13)` маркер. Auto-approve primary guardian по phone — defer на B6 (parent linking flow).

- **2026-04-26 · D14 · Process split по execution profile (api / worker / ws)** — на B9 разделяем cloud-процессы. До B9 — single-process. Не разделяем по user-role (admin/parent/super-admin same code).
- **2026-04-26 · D15 · Cloud + Edge topology** — Face/CCTV stack on-premise per kindergarten (mini-PC ~$400 docker-compose). Cloud-БД никогда не содержит face embeddings. Outbound-only WSS edge→cloud, mTLS, command/event pattern. На B18.5 — `edge_commands` / `edge_health` / `kindergarten_edge_credentials`. На B19 — `face_consents` (только согласие, не биометрия).

Полный лог архитектурных решений (D1–D16, P0–P5) — в migration memory `C:\Users\Doszhan\.claude\projects\c--Users-Doszhan-Desktop-work-projects-shyraq-app-backend-shyraq-v2\memory\project_v2_migration.md`.
