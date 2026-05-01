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
| **B7** Schedule & Meal | Migration `1777556957492-B7ScheduleAndMeal.ts`: 6 tables (`schedule_templates`, `schedule_slots`, `schedule_week_snapshots`, `activity_events`, `meal_plans`, `meal_plan_items`) + ENUMs (`activity_event_status`, `meal_type`) + FORCE RLS + partial-uniques. ScheduleModule: rich aggregate `ScheduleTemplate` with slot-conflict invariant; `ActivityEvent` state machine `scheduled → in_progress → completed\|cancelled` (terminal states reject reverse); `schedule_week_snapshots` per-week immutable copies; admin/staff/parent controllers. MealModule: `meal_plans` daily with both partial-unique idx branches for `group_id` NULL/NOT-NULL; multilingual `dish_name jsonb`; admin/staff/parent controllers. `WeeklyRolloutService` + cron (`@nestjs/schedule` `0 23 * * 0` Asia/Almaty) idempotent via `existsAnyInRange` short-circuit (meal) + tryCreate snapshot-first ordering (schedule); manual-trigger super-admin endpoint `POST /admin/schedule/week-rollout/run`; RLS-scoped per-kg via `tenantStorage.run`. T7 (opus) code-review caught 2 CRITICAL TX-poisoning bugs before merge; fix-pass `b27b5dc` closed them. Note: commit `9c16743` mis-titled "meal module" (sub-agent message-race during parallel T3/T4 run) — content is ScheduleModule; acknowledged in §5. Tests: unit 49 suites/527 tests (13/56 skipped), integration 61/62 suites 582/583 tests (1 pre-existing flaky enrollment ordering check), e2e 73→90 (+17: schedule/meal/weekly-rollout). |
| **B8** Attendance & Timeline (manual) | Migration `1777588264314-B8AttendanceAndTimeline.ts`: 3 tables (`attendance_events`, `child_daily_status`, `timeline_entries`) + 4 ENUMs (`attendance_event_type`, `attendance_method`, `child_intraday_status`, `timeline_entry_type`) + FORCE RLS + `tenant_isolation` policy + unique idx `(child_id, date)` + indexes on `(kg_id, recorded_at DESC)` / `(child_id, recorded_at DESC)` / `(child_id, entry_time DESC)` / `(kg_id, date)`. AttendanceModule with `attendance.service.ts` (`checkIn`, `checkOut`, `patchEvent`, `setDailyStatus`, `listEventsByChild`, `listEventsByGroup`, `listEvents`, `listByKindergarten`, `listDailyStatuses`, `dashboardAttendanceToday`, `getDailyStatusByChildAndDate`, `getEventById`) and `timeline.service.ts` (`createEntry`, `updateEntry`, `deleteEntry`, `listByChild`). Atomic 3-table TX flow on check-in/out (event + timeline entry + daily_status upsert) inside ambient TX from `TenantContextInterceptor`. Daily status only auto-promotes `absent\|late → present` on check-in; `sick\|on_vacation\|early_pickup\|present` preserved. Check-out does not mutate daily status. `setDailyStatus` upserts unconditionally. Pickup validation on check-out via `ChildGuardianRepository.findApprovedActivePickupGuardian` (requires status='approved' + revoked_at IS NULL + can_pickup=true). Edit window for non-admin staff PATCH: `recorded_at::date == today` in `Asia/Almaty` (`// TODO(B22): per-kg configurable`). Admin PATCH bypasses window. Future-date guard (5min skew tolerance) on `recordedAt`/`entryTime` writes (`InvalidAttendanceTimestampError`, code `invalid_attendance_timestamp` → 422). Controllers: `staff-attendance.controller.ts` (check-in/check-out/PATCH), `staff-timeline.controller.ts` (CRUD + author check), `staff-daily-status.controller.ts` (POST), `admin-attendance.controller.ts` (list events / single / PATCH no-window / dashboard / list daily / `/admin/children/:id/timeline`), `parent-attendance.controller.ts` (timeline / attendance / daily-status — `ChildAccessGuard`). NotificationPort extended: 4 new methods (`notifyAttendanceCheckIn`, `notifyAttendanceCheckOut`, `notifyDailyStatusChanged`, `notifyTimelineEntryCreated`) + 4 event interfaces. `LoggingNotificationAdapter` implements all with `// TODO(B9): WS fanout` markers. Post-commit dispatch fire-and-forget on microtask (`// TODO(B9): real afterCommit / Outbox` for B9 WS-fanout safety). `ChildGuardianRepository.findApprovedActivePickupGuardian` added (port + relational impl). Daily-status repo `list(filter)` supports `groupId` (INNER JOIN children on current_group_id). T6 review (opus): 0 CRITICAL / 2 HIGH / 4 MEDIUM / 5 LOW. T7 fix-pass `05cddc2` closed H1 (kg-wide event listing without filters), H2 (groupId now plumbed through dashboard), M1 (parent daily-status `?date=` validated via DTO `@Matches`), M3 (future-date guard), M4 (cross-tenant daily_status e2e). M2 (post-commit microtask docstring) refreshed; real afterCommit/outbox deferred to B9. Tests: unit 49 suites/527 → **51/569**, e2e 12/90 → **14/111**, integration unchanged. |
| **B9** Notifications + WebSocket | Migration `1777627742228-B9NotificationsAndOutbox.ts`: 4 tables — `notification_outbox` (FORCE RLS, partial idx `idx_outbox_pending` on `(status, next_retry_at) WHERE status IN ('pending','failed')` for efficient polling), `notifications` (FORCE RLS, per-user history), `push_tokens` (global by `user_id`, no RLS), `notification_preferences` (global by `user_id`, no RLS). Outbox-pattern: business TX writes to `notification_outbox` atomically via `OutboxNotificationAdapter`; worker process drains every 2s via `OutboxPollerProcessor` with `SELECT … FOR UPDATE SKIP LOCKED`. `NotificationDispatcher` resolves recipients (guardians via `ChildGuardianRepository`, mentors via `GroupMentorRepository`, direct `user_id`), applies `notification_preferences` filter + nanny-policy (`role='nanny'` receives only `attendance.*` + `pickup.*`), fans out to `PushNotificationPort` (MockPushAdapter logs; FcmPushAdapter stub for B22) + WS rooms + `notifications` history row. `NotificationGateway` @ `/ws` (socket.io v4): handshake JWT auth via `auth.token` field, auto-subscribe `user:{id}` + `child:{cid}` (approved guardians cross-tenant) + `group:{gid}` (active mentors cross-tenant). `RedisIoAdapter` for cross-process pub/sub between api and worker. BullMQ: `OutboxPollerProcessor` (repeatable 2s), `WeeklyRolloutProcessor` (migrated from `@nestjs/schedule` — distributed-lock free via Redis). Process split: `npm run start:worker` runs `src/main.worker.ts` entry. REST: `POST/DELETE /push-tokens`, `GET /notifications` (cursor-paged), `POST /notifications/:id/read` + `/read-all`, `GET/PATCH /notifications/preferences`. T8 closed all `// TODO(B9)` sites: synchronous `await` inside ambient TX (`attendance.service.ts`, `timeline.service.ts`), `notifyGuardianApproved` in `autoApprovePendingPrimaries`, `notifyGuardianSelfRevoked` in self-revoke. T9 surprise: `OutboxPollerProcessor` was missing `tenantStorage` propagation — silently RLS-dropped notifications — fixed inline. T10 opus review: 1 CRITICAL (dispatcher DB error poisoning entire worker batch → duplicate delivery on retry) + 1 MEDIUM (preferences PATCH race + first-insert default leak) + 1 LOW + 8 OBS. T11 fix-pass `e704acd`: CRITICAL closed via per-event savepoint (TypeORM nested transaction = SAVEPOINT) in `OutboxPollerProcessor`; MEDIUM closed via single-statement `INSERT … ON CONFLICT DO UPDATE` with EXCLUDED merge for preferences. Tests: unit 51/569 → **56/636** (+67 tests, +5 suites); e2e 14/111 → **16/119** (+8 tests, +2 suites: `notifications.e2e-spec.ts` + `websocket.e2e-spec.ts`). Closed in `e704acd`. |

**Текущее состояние (B9):** 56 unit suites / 636 tests green. Integration (INTEGRATION_DB=1): pre-existing env failures (`role "shyraq" is not permitted to log in`) tolerated — not a B9 regression. E2E: 16 suites / 119 tests. Build + lint: green. Endpoints под `/api/v1/...`. Swagger полный. B9 introduced worker process (`npm run start:worker`); api process unchanged.

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
- [x] **B6** — Parent Onboarding ✓ **demo-ready: BP §2** (commit `c4bc35b`)
- [x] **B7** — Schedule & Meal ✓ (commit `b27b5dc`)
- [x] **B8** — Attendance & Timeline (manual) ✓ **demo-ready: BP §5 manual** (commit `05cddc2`)
- [x] **B9** — Notifications + WebSocket ✓ (commit `e704acd`)
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
- [x] **BP §5** Daily Operations & Attendance *(B8 manual: check-in/check-out, timeline CRUD, daily status — Face/QR/OTP-pickup deferred to B19/B10/B11)*
- [ ] **BP §6** Parent Requests
- [ ] **BP §7** Pickup & Trusted Person OTP
- [ ] **BP §8** Diagnostics & Progress
- [ ] **BP §9** Content Management
- [x] **BP §10** Notifications & Parent Visibility *(B9: Outbox + WS gateway + push fanout — partial; per-actor matrix continues across batches)*
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
- **child.service.ts split (B6 leftover)** — после B6 файл вырос до ~880 строк (было ~700). CLAUDE.md §8 рекомендует разбить на role-specific (`child.service.ts` admin + `parent-child.service.ts` parent-flow). Не сделано в B6, чтобы не пересекаться с B5/P5 рефакторингом в одном PR. Маркер `// TODO(refactor): split child.service.ts on parent vs admin paths` стоит в `src/modules/child/child.service.ts` рядом с `linkChildByIin`. Отдельная задача после B7 или одной volna с B12 (когда parent-flow ещё расширится).
- **enrollment integration ordering flake (B5 leftover)** — `enrollment_status_log` ORDER BY `created_at ASC` fails when two rows share identical timestamps. Pre-existing; surfaced clean by B7 verification. Tolerated (not blocking B7). Fix in B22 polish or whoever next touches enrollment.
- **Commit `9c16743` mis-titled** — sub-agent message-race during parallel T3/T4 run committed ScheduleModule contents under "meal module" message. Body of follow-up commit `18bdc8c` documents the slip. Not amended (CLAUDE.md §10 forbids amend without explicit request). Re-amend if/when user OKs.
- **`mentor-group scope on timeline writes` (B8 T4 observation)** — staff timeline POST/PATCH/DELETE currently allows any active staff in kg, not just the child's group mentor. Tightening this requires resolving "current group" + mentor assignment for each request — defer to B22 polish or a dedicated security pass when staff role boundaries are formally specified. Marker `// TODO(B22): tighten mentor-group scope on timeline writes` in `src/modules/attendance/staff-timeline.controller.ts`.
- **Outbox payload schema drift (B9 T10 observation)** — `notification_outbox.payload` is `Record<string, unknown>`; `NotificationDispatcher` reads named fields at runtime without compile-time guarantees. Future: typed payload contracts in shared-kernel (B22 polish). No `// TODO` marker needed.
- **Notification locale resolution (B9 T10 observation)** — dispatcher uses `titleI18n.ru` for FCM title; client picks locale from raw jsonb in REST. Future: per-user locale lookup via `UsersRepository` in dispatcher (B22 polish).
- **failed-event prune job (B9 observation)** — `notification_outbox` rows with `status='failed'` accumulate forever (partial idx excludes them from poll, no perf hit, just table growth). Future: monthly prune job (B22 polish).
- **WS room broadcasts not yet child-room-scoped (B9 observation)** — dispatcher fans out via `broadcastToUser` only. `broadcastToChild`/`broadcastToGroup` ports exist but are unused. When B17 (stories) needs child-room broadcast, add tenant-of-room check to prevent cross-kg leakage on uuid collision.
- **OutboxPollerProcessor sequential per-event (B9 observation)** — for high-volume tenants in-batch dispatch latency stacks linearly. Future: `Promise.all` once per-event TX-isolation is verified at scale (B22 polish).

### Resolved (исторические — full log в memory)

- **2026-05-01 · B9 · Notifications + WebSocket** — Outbox-pattern table `notification_outbox` (FORCE RLS, `idx_outbox_pending` partial idx) writes inside business TX. BullMQ worker process (`src/main.worker.ts`) drains via `OutboxPollerProcessor` every 2s with `FOR UPDATE SKIP LOCKED` claim + per-event savepoint isolation. `NotificationDispatcher` resolves recipients (guardians for child-events, mentor for group-events) + applies `notification_preferences` + nanny-policy filter, fans out to push (`PushNotificationPort` + `MockPushAdapter`, `FcmPushAdapter` stub for B22) + WS rooms + history rows in `notifications` table. `NotificationGateway` @ `/ws` with handshake JWT auth (`auth.token`, not query) + auto-subscribe `user:{id}` + `child:{cid}` (approved guardians cross-tenant) + `group:{gid}` (active mentors cross-tenant). `RedisIoAdapter` for cross-process pub/sub (api ↔ worker). REST: `POST/DELETE /push-tokens`, `GET /notifications` (cursor-paged), `POST /:id/read` + `/read-all`, `GET/PATCH /notifications/preferences`. T8 closed all `// TODO(B9)` sites: synchronous `await notifyXyz(...)` inside ambient TX (atomic with business mutation), `notifyGuardianApproved` emit added in `autoApprovePendingPrimaries`, `notifyGuardianSelfRevoked` emit in self-revoke. T9 surprise: `OutboxPollerProcessor` missing `tenantStorage` propagation — silently RLS-dropped notifications — fixed inline. T10 opus review: 1 CRITICAL (dispatcher DB error poisoning entire worker batch → duplicate delivery) + 1 MEDIUM (preferences PATCH race + first-insert default leak) + 1 LOW + 8 OBS. T11 fix-pass `e704acd` closed CRITICAL via per-event savepoint in `OutboxPollerProcessor` and MEDIUM via single-statement `INSERT … ON CONFLICT DO UPDATE` with EXCLUDED merge. Migration `1777627742228-B9NotificationsAndOutbox.ts` (4 tables). Tests: unit 51→56 suites / 569→636 tests; e2e 14→16 suites / 111→119 tests. Closed in `e704acd`.

- **2026-05-01 · B9 · autoApprovePendingPrimaries без notify (B6 leftover)** — `notifyGuardianApproved` emitted synchronously inside per-kg TX in `autoApprovePendingPrimaries` (T8). Resolved.

- **2026-05-01 · B9 · schedule:weekly-rollout cron lock (B7 T5 leftover)** — `weekly-rollout.cron.ts` deleted; `WeeklyRolloutProcessor` migrated to BullMQ repeatable-job with Redis-based distributed lock free via `BZPOPMIN` (T6). Resolved.

- **2026-05-01 · B9 · NotificationPort post-commit microtask vs afterCommit (B8 leftover)** — all `fireAndForget` wrappers replaced with synchronous `await notifyXyz(...)` inside the same ambient TX; `OutboxNotificationAdapter` writes atomically via `tenantStorage` `EntityManager` (T8). Resolved.

- **2026-05-01 · B8 · Attendance & Timeline (manual)** — manual check-in/out, timeline CRUD, daily-status. Atomic 3-table TX inside ambient interceptor TX. Pickup validation via approved guardian + can_pickup. Edit window same-day Asia/Almaty for non-admin staff. NotificationPort +4 methods (logging adapter + B9 WS TODO). Migration `1777588264314-B8AttendanceAndTimeline.ts`. T6 opus review caught 0 CRITICAL + 2 HIGH (admin filters, dashboard groupId) + 4 MEDIUM; T7 fix-pass `05cddc2` closed all. Closed in `05cddc2`.

- **2026-04-30 · B7 · Cron-механизм для weekly auto-copy** — выбран `@nestjs/schedule` (`@Cron('0 23 * * 0', { timeZone: 'Asia/Almaty' })`), реализован в `WeeklyRolloutService`. Идемпотентность через `existsAnyInRange` short-circuit (meal) + tryCreate snapshot-first ordering (schedule). Distributed lock (`// TODO(B9): add cron lock via Redis SET NX EX`) отложен до B9 (горизонтальное масштабирование). Закрыт в `b27b5dc`.

- **2026-04-30 · B6 · Parent Onboarding** — link/unlink endpoints implemented (`POST /parent/children/link`, `POST /parent/children/:id/unlink`), auto-approve primary в `verifyOtp` (defer from B5 — closed). Parent JWT scope (P5 leftover) — closed via `6b0a929` и exercised by Scenario A e2e. ForbiddenActionError base введён в shared-kernel; DomainErrorFilter now passes through `details` for clients (used by `multiple_children_for_iin`). No DB migration needed.

- **2026-04-30 · B5 · Enrollment** — invoice generation на `card_created` — defer на B13. Hook-point: `EnrollmentService.transition()` где помечен `// TODO(B13)` маркер. Auto-approve primary guardian по phone — defer на B6 (parent linking flow).

- **2026-04-26 · D14 · Process split по execution profile (api / worker / ws)** — на B9 разделяем cloud-процессы. До B9 — single-process. Не разделяем по user-role (admin/parent/super-admin same code).
- **2026-04-26 · D15 · Cloud + Edge topology** — Face/CCTV stack on-premise per kindergarten (mini-PC ~$400 docker-compose). Cloud-БД никогда не содержит face embeddings. Outbound-only WSS edge→cloud, mTLS, command/event pattern. На B18.5 — `edge_commands` / `edge_health` / `kindergarten_edge_credentials`. На B19 — `face_consents` (только согласие, не биометрия).

Полный лог архитектурных решений (D1–D16, P0–P5) — в migration memory `C:\Users\Doszhan\.claude\projects\c--Users-Doszhan-Desktop-work-projects-shyraq-app-backend-shyraq-v2\memory\project_v2_migration.md`.
