# Admin Dashboard Backend — Implementation Plan

> **Назначение этого файла.** Это самодостаточный handoff для **одной** Claude-сессии с
> чистым контекстом. Сессия реализует 3 admin-dashboard эндпоинта от начала до
> прохождения CI. Не суб-агентная работа: фазы зависимы и шарят одни и те же
> решения по формулам/DTO — дроби только теряется когерентность.
>
> **⚠️ Статус трекинга.** Этот файл (`DASHBOARD_BACKEND_PLAN.md`) — **трекается** и
> коммитится **первым коммитом** ветки как контракт работы (см. `.gitignore`:
> `/docs/admin_frontend/*` + `!`-исключение только для этого файла). **Остальное** в
> `docs/admin_frontend/` (в т.ч. `ADMIN_FRONTEND_HANDOFF.md`) и вся
> `docs/superadmin_fixes/` — **gitignored, НЕ коммитятся, НЕ идут в PR**. Никогда не
> делай `git add -f` и не `git add .`/`-A` вслепую — добавляй только конкретные пути:
> этот план, `src/`, `test/`, `docs/endpoints.md`, `IMPLEMENTATION_PLAN.md`, `.gitignore`.
>
> **Перед стартом прочитай в этом порядке:**
> 1. `CLAUDE.md` — §4 (module layout brocoders + ports/adapters), §5 (multi-tenancy
>    RLS), §7 (4 уровня тестов), §8 (coding rules), §9 (adding a new module), §10 (do not).
> 2. `docs/endpoints.md` §2.22 (строки ~887–893) — целевой контракт уже задокументирован.
> 3. `docs/admin_frontend/ADMIN_FRONTEND_HANDOFF.md` §26 (строки ~615–623) — что ждёт фронт.
> 4. Этот файл целиком.
>
> **Бизнес-контекст.** Фронт админки сообщил: на live backend `/admin/dashboard/summary`
> и `/admin/dashboard/payments-overview` → **404** (не реализованы — модуля нет вообще),
> а `/admin/dashboard/attendance-today` существует, но отдаёт **массив сырых строк**
> `child_daily_status[]` вместо документированного агрегата. Итог: из 3 виджетов
> дашборда не работает ни один полностью. Контракт в `endpoints.md` §2.22 правильный —
> приводим код к нему.

---

## 0. Зафиксированные продуктовые решения (НЕ переобсуждать)

Эти 5 решений утверждены пользователем. Реализуй ровно так. Любое отклонение
требует возврата к пользователю.

| # | Решение |
|---|---|
| 1 | **Объём:** все 3 эндпоинта в одной ветке, один squash-merge после зелёного CI. Полный scope включает provider-breakdown и переделку `attendance-today`. |
| 2 | **`enrollments_in_processing`** = COUNT enrollments где `status IN ('new','in_processing','waitlist')` (вся активная воронка, не только литеральный `in_processing`). |
| 3 | **`mtd_revenue` / `ytd_revenue`** = **БРУТТО**: `SUM(payments.amount)` где `status='completed'`, фильтр по `paid_at`, календарный месяц/год в **Asia/Almaty**. Возвраты **НЕ вычитаются** (видны отдельно в payments-overview). Это устраняет рассинхрон периодов (майский refund апрельского платежа не должен резать майскую выручку). |
| 4 | **`overdue`** (и `summary.invoices_overdue_*`, и бакет `overdue` в payments-overview) = инвойсы где `due_date < сегодня (Asia/Almaty)` **AND** `status IN ('pending','partial')`. Вычисляем по due_date, НЕ полагаемся на `status='overdue'` (фоновый переход pending→overdue может не выполняться → ложные нули). |
| 5 | **active_*:** `active_children` = `child.status = 'active'`; `active_staff` = `is_active = true AND archived_at IS NULL`; `active_groups` = `groups.archived_at IS NULL`. (Из кода, не спорно.) |

---

## 1. Архитектурное решение

Создаём **новый модуль `src/modules/dashboard/`** — read-only аналитический агрегатор.

**Важно — это НЕ полноценный brocoders-модуль (§9):**
- ❌ Нет своей таблицы → **нет миграции**, нет `domain/entities`, нет TypeORM-entity,
  нет mapper, нет своего `<x>.repository.ts` port.
- ✅ Есть только: `dashboard.controller.ts`, `dashboard.service.ts`, `dashboard.module.ts`,
  `dto/`, `dashboard.service.spec.ts`. Presenter не обязателен — сервис возвращает
  плоские агрегатные объекты, контроллер мапит в DTO напрямую (тонко).
- Сервис **не** импортирует `typeorm`/`Repository`/`ioredis` (§8). Он зависит только от
  **уже существующих abstract-портов** других модулей (`ChildRepository`,
  `EnrollmentRepository`, `InvoiceRepository`, `PaymentRepository`, `RefundRepository`,
  `StaffMemberRepository`, `GroupRepository`, `AttendanceEventRepository`,
  `ChildDailyStatusRepository`), которые мы расширяем новыми агрегатными методами.

**Почему агрегаты живут в существующих портах, а не в новом dashboard-репозитории:**
каждый счётчик принадлежит своему bounded-context (invoices считает InvoiceRepository,
payments — PaymentRepository). DashboardService только композирует их через
`Promise.all`. Это сохраняет layer-rules §4 и RLS (каждый репо-метод сам берёт
`tenantStorage` manager).

### 1.1 КРИТИЧНО: паттерн default-stub при расширении чужих портов

Существующие service-spec'ы по всему репозиторию используют **рукописные in-memory
fakes** портов (§7). Если добавить в abstract-порт новый `abstract`-метод — **все эти
fakes перестанут компилироваться** и сломаются десятки тестов в других модулях.

Решение — повторить уже принятый в репо паттерн. Эталон:
`src/modules/group/infrastructure/persistence/group.repository.ts:132-138`
(`isUserActiveMentorForGroup` — non-abstract метод с дефолт-заглушкой):

```ts
// В abstract class XxxRepository — НЕ abstract, с дефолтом:
/**
 * Dashboard aggregate (B-DASH). Default stub so older in-memory test fakes
 * compile; the relational impl overrides with a real COUNT/SUM query.
 */
countActiveByKindergarten(_kindergartenId: string): Promise<number> {
  return Promise.resolve(0);
}
```

Реализацию кладём в relational-репозиторий (`@Override`-семантика — просто метод с тем
же именем). Так старые fakes наследуют дефолт и компилируются, а прод-путь использует
SQL. **Каждый новый метод во всех 9 портах добавляем именно так.**

### 1.2 RLS / EntityManager (§5)

Все новые relational-методы обязаны резолвить manager через стандартный helper
`this.manager(manager?)` (он берёт `tenantStorage.getStore()?.entityManager ?? this.repo.manager`).
Иначе агрегатный запрос уйдёт мимо per-transaction GUC `app.kindergarten_id` и RLS-фильтр
не применится. Service.ts всё равно явно передаёт `kindergartenId` первым аргументом
(§8) — defense-in-depth + читаемость. Смотри готовый пример SUM-метода:
`src/modules/billing/infrastructure/persistence/relational/repositories/invoice.relational.repository.ts:161-176`
(`getPaidSumForInvoice`, raw SQL c `COALESCE(SUM(...),0)::text`), и COUNT-метода:
`src/modules/billing/infrastructure/persistence/relational/repositories/custom-discount-application.relational.repository.ts:60-70`
(QueryBuilder `.getCount()`).

### 1.3 Asia/Almaty границы периодов

Эталон «сегодня в Asia/Almaty» уже в коде:
`src/modules/attendance/attendance.service.ts:537-539`:
```ts
const today = this.clock.now().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
```
`ClockPort` — `src/shared-kernel/application/ports/clock.port.ts` (abstract `now(): Date`).
Шаред-утилиты для границ месяца/года **нет** — посчитать инлайн в DashboardService
из `this.clock.now()`:
- `today` (YYYY-MM-DD, Asia/Almaty) — для overdue и attendance-today.
- `monthStart` = первый день текущего месяца Asia/Almaty (YYYY-MM-DD).
- `yearStart` = 1 января текущего года Asia/Almaty (YYYY-MM-DD).
Almaty = UTC+5, без DST — границу дня/месяца считать смещением +5ч от UTC, затем
обратно в UTC для сравнения с `timestamptz` колонками (`paid_at`, `updated_at`).
Вынеси расчёт в маленький приватный helper в сервисе + покрой unit-тестом
(заморозить ClockPort на конкретный момент, проверить границы около полуночи Almaty).

---

## 2. Целевые контракты (привести код ровно к этому)

### 2.1 `GET /api/v1/admin/dashboard/summary`
- Guard/Roles: как у существующего `AdminAttendanceController`
  (`@Controller({ path: 'admin', version: '1' })`, `JwtAuthGuard, PendingRoleSelectGuard,
  RolesGuard`, `@Roles('admin','reception')`, `@ApiBearerAuth()`). Tenant из `@Tenant()`,
  через `requireTenant(t)` (паттерн в `admin-attendance.controller.ts:44-49`).
- Query: нет.
- 200 response:
```json
{
  "active_children": 128,
  "enrollments_in_processing": 9,
  "invoices_overdue_count": 4,
  "invoices_overdue_amount": 320000,
  "mtd_revenue": 1850000,
  "ytd_revenue": 14200000,
  "active_staff": 23,
  "active_groups": 8
}
```
- Денежные поля — целые тенге (`MoneyKzt` маппится числом; `getPaidSumForInvoice`
  возвращает `Number(sum)` — следуй тому же).
- Ошибки: 401 (нет/невалиден Bearer), 403 (не admin/reception).

### 2.2 `GET /api/v1/admin/dashboard/payments-overview`
- Query: `from` (YYYY-MM-DD, required), `to` (YYYY-MM-DD, required). Валидация
  class-validator (`@IsDateString`), `to >= from` → иначе 400 `invalid_date_range`.
- 200 response:
```json
{
  "paid":     { "count": 96, "amount": 1850000 },
  "pending":  { "count": 14, "amount": 260000 },
  "overdue":  { "count": 4,  "amount": 320000 },
  "refunded": { "count": 2,  "amount": 38000 },
  "by_provider": [
    { "provider": "kaspi_pay",   "count": 80, "amount": 1600000 },
    { "provider": "halyk_epay",  "count": 16, "amount": 250000 }
  ]
}
```
- **Семантика бакетов (документированное допущение — реализуем так, в PR-описании
  явно перечислить для согласования с фронтом):**
  - Базис бакетов `paid/pending/overdue/refunded` — **инвойсы** (у платежей нет
    статуса `overdue`/`pending` в нужном смысле; документированная форма
    `{paid,pending,overdue,refunded}` совпадает с invoice-статусами). Сумма —
    `amount_after_discount`.
    - `paid` = `invoice.status = 'paid'`.
    - `pending` = `invoice.status IN ('pending','partial')` **И НЕ** overdue
      (т.е. `due_date >= today`).
    - `overdue` = решение #4 (`due_date < today AND status IN ('pending','partial')`).
    - `refunded` = `invoice.status = 'refunded'`.
    - Фильтр периода для бакетов: по `invoice.period_start` ∈ `[from, to]`.
  - `by_provider` — **платежи** (только у них есть `provider`):
    `GROUP BY provider`, `status='completed'`, `paid_at ∈ [from,to]`,
    `count` + `SUM(amount)`. `provider` ∈
    `('mock','halyk_epay','kaspi_pay','tiptoppay','freedom_pay','cash')`
    (CHECK-констрейнт, см. миграцию `1777886401000-B13BillingAndInvoices.ts`).
- Ошибки: 400 (валидация дат), 401, 403.

### 2.3 `GET /api/v1/admin/dashboard/attendance-today` (ПЕРЕДЕЛКА существующего)
- Сейчас живёт в `AdminAttendanceController` и отдаёт `DailyStatusResponseDto[]`.
  **Переносим маршрут в новый `DashboardController`** и меняем форму ответа на агрегат.
  Старый метод `dashboardAttendanceToday` в `AttendanceService` + presenter +
  `DailyStatusResponseDto` для этого роута **больше не используются этим эндпоинтом**
  (но `GET /admin/daily-status` и `GET /admin/daily-status/summary` их используют —
  НЕ удаляй их, только сними роут `dashboard/attendance-today` из
  `AdminAttendanceController`).
- Query: `group_id` (UUID, optional — snake_case, не `groupId`!),
  `date` (YYYY-MM-DD, optional, default = сегодня Asia/Almaty).
- 200 response:
```json
{ "in_kindergarten": 42, "checked_out": 7, "absent": 5, "on_vacation": 3, "sick": 2 }
```
- **Семантика (документированное допущение, перечислить в PR):**
  - `in_kindergarten` = число детей, у кого за `date` (Asia/Almaty день) последнее
    событие в `attendance_events` = `check_in` (есть check_in и нет более позднего
    `check_out`).
  - `checked_out` = последнее событие за день = `check_out`.
  - `absent` = `child_daily_status.status='absent'` за `date` И нет ни одного
    `attendance_events` check_in за день.
  - `on_vacation` = `child_daily_status.status='on_vacation'` за `date`.
  - `sick` = `child_daily_status.status='sick'` за `date`.
  - `late`/`early_pickup`: если есть check_in → попадает в in_kindergarten/checked_out
    по правилу событий; если событий нет — не считается ни в один бакет (документируем).
  - Фильтр `group_id`: `attendance_events` НЕ имеет `group_id` → join через
    `children.current_group_id = :group_id` (см. `child.entity` колонку
    `current_group_id`). Применять и к событийной части, и к daily_status части.

---

## 3. Пофайловая разбивка работ

> Точные пути abstract-портов и relational-имплов (проверены):
>
> | Контекст | Abstract port | Relational impl |
> |---|---|---|
> | child | `src/modules/child/infrastructure/persistence/child.repository.ts` | `.../relational/repositories/child.repository.ts` |
> | enrollment | `src/modules/enrollment/infrastructure/persistence/enrollment.repository.ts` | `.../relational/repositories/enrollment-relational.repository.ts` |
> | invoice | `src/modules/billing/infrastructure/persistence/invoice.repository.ts` | `.../relational/repositories/invoice.relational.repository.ts` |
> | payment | `src/modules/billing/infrastructure/persistence/payment.repository.ts` | `.../relational/repositories/payment.relational.repository.ts` |
> | refund | `src/modules/billing/infrastructure/persistence/refund.repository.ts` | `.../relational/repositories/refund.relational.repository.ts` |
> | staff | `src/modules/staff/infrastructure/persistence/staff-member.repository.ts` | `.../relational/repositories/staff-member.repository.ts` |
> | group | `src/modules/group/infrastructure/persistence/group.repository.ts` | `.../relational/repositories/group.repository.ts` |
> | attendance-event | `src/modules/attendance/infrastructure/persistence/attendance-event.repository.ts` | `.../relational/repositories/attendance-event.relational.repository.ts` |
> | child-daily-status | `src/modules/attendance/infrastructure/persistence/child-daily-status.repository.ts` | `.../relational/repositories/child-daily-status.relational.repository.ts` |

### Фаза A — каркас DashboardModule (без логики)
1. `src/modules/dashboard/dto/dashboard-summary.response.ts` — DTO с `@ApiProperty`
   (реалистичный `example` на каждое поле, §8). snake_case имена полей как в контракте.
2. `src/modules/dashboard/dto/payments-overview.query.ts` — `from`,`to`
   (`@IsDateString`, `@ApiProperty`).
3. `src/modules/dashboard/dto/payments-overview.response.ts` — вложенные
   `{count,amount}` + `by_provider[]`. Отдельный класс под bucket и под provider-row
   (Swagger требует именованные типы).
4. `src/modules/dashboard/dto/attendance-today.query.ts` — `group_id?`,`date?`.
5. `src/modules/dashboard/dto/attendance-today.response.ts`.
6. `src/modules/dashboard/dashboard.service.ts` — пока сигнатуры методов
   (`getSummary(kgId)`, `getPaymentsOverview(kgId,{from,to})`,
   `getAttendanceToday(kgId,{groupId,date})`) + private date-helper, тела — заглушки.
7. `src/modules/dashboard/dashboard.controller.ts` — 3 роута, guards/roles как в §2.1,
   полный Swagger (`@ApiOkResponse`, `@ApiBadRequestResponse`,
   `@ApiUnauthorizedResponse`, `@ApiForbiddenResponse`, `@ApiQuery`, `@ApiOperation`,
   `@ApiTags('Admin / Dashboard')`, `@ApiBearerAuth()`).
8. `src/modules/dashboard/dashboard.module.ts` — паттерн `group.module.ts`:
   `imports: [ChildModule, EnrollmentModule, BillingModule, StaffModule, GroupModule,
   AttendanceModule]` (или их под-модули, экспортирующие нужные порты — проверь, что
   каждый модуль `exports` свой `XxxRepository`; если нет — добавить в `exports`
   соответствующего модуля; при циклах — `forwardRef`). `controllers:[DashboardController]`,
   `providers:[DashboardService]`. Портовых `{provide,useClass}` тут НЕ объявляем —
   они приходят из импортируемых модулей.
9. Зарегистрировать `DashboardModule` в `src/app.module.ts` (рядом с прочими feature-модулями).
10. **Чекпойнт A:** `npm run build` зелёный (каркас компилируется, тесты-заглушки не нужны).

### Фаза B — summary
Добавить default-stub методы (§1.1) в порты + relational-импл:
- `ChildRepository.countActiveByKindergarten(kgId): Promise<number>`
  → SQL `COUNT(*) WHERE kindergarten_id=$1 AND status='active'`.
- `EnrollmentRepository.countInProcessing(kgId): Promise<number>`
  → `status IN ('new','in_processing','waitlist')` (решение #2).
- `InvoiceRepository.aggregateOverdue(kgId, today): Promise<{count:number;amount:number}>`
  → `due_date < $today AND status IN ('pending','partial')`,
  `COUNT(*)` + `COALESCE(SUM(amount_after_discount),0)`.
- `PaymentRepository.sumCompletedBetween(kgId, fromIso, toIso): Promise<number>`
  → `status='completed' AND paid_at >= $from AND paid_at < $toExclusive`,
  `COALESCE(SUM(amount),0)`. Вызвать дважды (monthStart..now, yearStart..now) ИЛИ
  один параметризованный метод. Границы — в UTC из Asia/Almaty (§1.3).
- `StaffMemberRepository.countActive(kgId): Promise<number>`
  → `is_active=true AND archived_at IS NULL`.
- `GroupRepository.countActive(kgId): Promise<number>`
  → `archived_at IS NULL`.

`DashboardService.getSummary` — `Promise.all` всех шести (+revenue x2), собрать DTO.
**Чекпойнт B:** build + новые unit-тесты для summary (см. §4) зелёные.

### Фаза C — payments-overview
- `InvoiceRepository.aggregateByStatusBetween(kgId, fromIso, toIso, today)`
  → вернуть бакеты paid/pending/overdue/refunded по правилам §2.2 (один запрос с
  `CASE`/`FILTER`, фильтр `period_start ∈ [from,to]`).
- `PaymentRepository.aggregateByProviderBetween(kgId, fromIso, toIso)`
  → `GROUP BY provider, status='completed', paid_at ∈ [from,to]`, count+sum.
`DashboardService.getPaymentsOverview` композирует. Валидация `to>=from` в DTO/сервисе.
**Чекпойнт C:** build + unit-тесты payments-overview зелёные.

### Фаза D — attendance-today (переделка)
- `ChildDailyStatusRepository.countByStatusForDate(kgId, date, groupId?)`
  → `GROUP BY status` за `date`, опц. join `children.current_group_id`.
- `AttendanceEventRepository.lastEventBucketsForDate(kgId, date, groupId?)`
  → на ребёнка взять последнее событие за день (`DISTINCT ON (child_id) ... ORDER BY
  child_id, recorded_at DESC` в окне дня Asia/Almaty), вернуть
  `{in_kindergarten, checked_out}` + множество child_id с check_in (для корректного
  `absent`-исключения). Опц. join `children.current_group_id`.
- `DashboardService.getAttendanceToday` — собрать 5 чисел по семантике §2.3.
- В `AdminAttendanceController` **удалить** роут-метод `dashboardToday`
  (`@Get('dashboard/attendance-today')`, `admin-attendance.controller.ts:144-173`)
  и его теперь-неиспользуемые импорты, если они больше нигде не нужны в файле.
  `AttendanceService.dashboardAttendanceToday` оставить только если его ещё
  использует `daily-status` — проверь grep; если нет потребителей кроме удалённого
  роута — удалить метод И его тест-блок
  `attendance.service.spec.ts` (`describe('dashboardAttendanceToday — groupId
  filter (T6 H2)')`, ~строки 1122–1180). Если используется — не трогать.
**Чекпойнт D:** build + unit зелёные + сломанные attendance-спеки починены.

### Фаза E — доки + план
- **`docs/endpoints.md` §2.22 — ТРЕКАЕТСЯ, идёт в PR.** Контракт уже верный; уточнить
  только что параметр `attendance-today` — `group_id` (snake_case) и `date`. Сверить
  формулировки с §2 этого файла.
- **`IMPLEMENTATION_PLAN.md` — ТРЕКАЕТСЯ, идёт в PR.** Добавить запись батча (формат
  как у существующих — миграция-нет, модуль, тесты, итог по числу suites/tests).
  Псевдо-код батча, например `B-DASH Admin Dashboard`.
- `docs/admin_frontend/ADMIN_FRONTEND_HANDOFF.md` §26 — **gitignored, локально, НЕ в
  PR.** Обновить как локальную заметку (добавить `by_provider`, пометить эндпоинты
  реализованными) полезно для дальнейшей работы фронта, но в коммит это не попадёт и
  попадать не должно. Не `git add -f`.
- Docs-first (§3 CLAUDE.md) соблюдаем через трекаемые `endpoints.md` +
  `IMPLEMENTATION_PLAN.md` — они и код в одном финальном состоянии ветки/PR.

---

## 4. Тестирование (§7) — обязательно

| Уровень | Что покрыть |
|---|---|
| **service-unit** `src/modules/dashboard/dashboard.service.spec.ts` | Рукописные in-memory fakes всех 9 портов (НЕ jest automock). Кейсы: summary считает каждое поле; пустой садик → все нули; revenue использует правильные границы Asia/Almaty (заморозить ClockPort на момент у полуночи Almaty — проверить, что платёж в 23:30 UTC попадает в нужный месяц); overdue по due_date (не по статусу); payments-overview бакеты + by_provider; attendance-today маппинг событий (last-event-wins: check_in→in_kindergarten, check_in+later check_out→checked_out), group_id фильтр. |
| **service-unit (регресс)** | Прогнать весь `npm test` — убедиться, что НИ ОДИН существующий fake в других модулях не сломан (это проверка, что default-stub паттерн §1.1 применён везде). |
| **e2e** `test/dashboard.e2e-spec.ts` | Через Supertest/HTTP. **Cross-tenant phantom-row** (§9 п.11): kg_A vs kg_B — создать данные в обоих, дернуть summary/overview/attendance под токеном admin kg_A, убедиться что цифры kg_B НЕ протекают (RLS + явный kgId). 401 без Bearer, 403 под parent-токеном, 400 на `from>to`. Помнить: `npm run test:e2e` → `maxWorkers:1`. |
| **integration** (опц.) | Если агрегатный SQL нетривиален (DISTINCT ON, FILTER) — `*.integration-spec.ts` против реального PG (`INTEGRATION_DB=1`), без моков. |

Test naming строго: `it('returns ...')`, `it('throws ...')`, `it('rejects ...')` —
**не** `it('should ...')`.

---

## 5. Команды / чекпойнты

```bash
# на каждом чекпойнте фазы:
npm run build
npm test                       # unit (domain+service) — должно быть зелёным целиком
INTEGRATION_DB=1 npm test      # если трогали integration (нужен docker PG+Redis)
npm run test:e2e               # после фаз A–D, перед PR
npm run lint                   # husky pre-commit всё равно прогонит; не пропускать (§10)
```

Husky pre-commit обязателен — при падении чинить причину и пере-коммитить, **не**
`--no-verify` (§10).

---

## 6. Git workflow (утверждён пользователем)

```bash
git checkout -b feat/admin-dashboard-endpoints   # от актуального main
# коммиты по фазам (атомарные, не amend без запроса — §10):
#   chore(dashboard): track impl plan + .gitignore exception
#                     (git add docs/admin_frontend/DASHBOARD_BACKEND_PLAN.md .gitignore)
#   feat(dashboard): scaffold DashboardModule + DTOs (no logic)
#   feat(dashboard): GET /admin/dashboard/summary
#   feat(dashboard): GET /admin/dashboard/payments-overview
#   refactor(dashboard): move attendance-today to aggregate contract
#   test(dashboard): service-unit + cross-tenant e2e
#   docs(dashboard): sync endpoints.md + IMPLEMENTATION_PLAN.md
# NB: ТРЕКАЕТСЯ и идёт в PR: этот план, src/, test/, docs/endpoints.md,
#     IMPLEMENTATION_PLAN.md, .gitignore. IGNORED (НЕ коммитить, не `git add -f`):
#     остальное в docs/admin_frontend/ (вкл. ADMIN_FRONTEND_HANDOFF.md),
#     docs/superadmin_fixes/. Добавляй только конкретные пути — никогда
#     `git add -A`/`git add .` вслепую.
git push -u origin feat/admin-dashboard-endpoints
gh pr create --base main --title "feat: admin dashboard endpoints (summary, payments-overview, attendance-today aggregate)" --body "<см. ниже>"
```
PR-body обязан содержать раздел **«Документированные допущения для согласования с
фронтом»** — перечислить семантику бакетов payments-overview (§2.2) и attendance-today
(§2.3 — судьба `late`/`early_pickup`, источник `paid/pending/refunded` = инвойсы).

**Merge — squash and merge только после зелёного CI.** Не мержить с красным/жёлтым CI.
Коммитить от лица `Doszhan Rakhmetov` (git config репо). Не коммить самому без
явного шага — следуй фазовым чекпойнтам и дай пользователю подтвердить перед push/PR
если так принято в его workflow.

---

## 7. Definition of Done

- [ ] 3 эндпоинта возвращают ровно формы из §2 (snake_case поля, целые тенге).
- [ ] `summary`/`payments-overview` больше не 404; `attendance-today` — агрегат, не массив.
- [ ] Все 5 решений §0 соблюдены буквально.
- [ ] Default-stub паттерн §1.1 применён ко ВСЕМ новым методам портов; `npm test`
      зелёный целиком (никаких сломанных чужих fakes).
- [ ] Новые relational-методы используют `this.manager()` (RLS, §1.2).
- [ ] service-unit + cross-tenant e2e зелёные; e2e гоняется `maxWorkers:1`.
- [ ] `build` + `lint` + полный `test` + `test:e2e` зелёные локально.
- [ ] Доки (endpoints.md §2.22, HANDOFF §26, IMPLEMENTATION_PLAN.md) синхронны коду.
- [ ] PR открыт, CI зелёный, в PR-body перечислены допущения для фронта.
- [ ] Squash-merge только после зелёного CI.

---

## 8. Открытые допущения (НЕ блокируют; реализуем default, фронт подтверждает в PR)

1. Базис бакетов payments-overview = инвойсы; provider-breakdown = платежи (§2.2).
2. Период payments-overview бакетов фильтруется по `invoice.period_start` (альтернатива
   — `due_date`/`created_at`; если фронт скажет иначе — тривиальная правка одного `WHERE`).
3. `late`/`early_pickup` в attendance-today не имеют своего бакета (§2.3).
4. Денежные значения — целые тенге числом (как `getPaidSumForInvoice` → `Number`).

Если в ходе работы выявится противоречие контракта с реальностью БД (например, у
инвойса нет `period_start`, а есть `period`) — **не выдумывай**, сверься с TypeORM
entity и зафиксируй фактическую колонку в PR-описании.
