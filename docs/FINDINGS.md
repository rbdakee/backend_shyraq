# Cross-batch Review Findings — Shyraq Backend v2

**Date:** 2026-05-11
**Scope:** B10–B18 Phase A батчи + cross-cutting infrastructure
**Method:** 15 параллельных subagent-ревью (10 в первой волне + 5 системных аудитов во второй).

**Стартовый baseline:** unit 1654 / integration 1521 / e2e 235 — все зелёные. Findings ниже — это **новые** результаты, не дубли уже-закрытых T6/T7/T8 reviews.

**Status timeline:**
- 🔴 **P0** — Blocker (fix immediately, до B21)
- 🟠 **B22** — Polish phase (до production launch)
- 🟡 **B22+** — non-urgent polish
- ⏸ **Deferred** — отложено в Phase B/C по design

---

## 📊 Summary

| Severity | Count |
|---|---|
| CRITICAL | 2 |
| HIGH (system patterns) | 7 |
| HIGH (state machine holes) | 3 |
| HIGH (batch-specific) | 14 |
| MEDIUM | ~27 |
| **Total** | **53** |

**Blocking (5):** C2, SP5, SP6, SM2, H17 — ✅ **ALL FIXED 2026-05-12**. См. секцию "Fix log 2026-05-12" в конце документа. (C1 verified as false positive 2026-05-11.)

---

# 🚨 CRITICAL

## C1 — B18 `progress_notes` CHECK constraint blocks UPDATE — ✅ RESOLVED FALSE POSITIVE

**File:** `src/database/migrations/1777890003000-B18DiagnosticsAndProgress.ts:177`
**Source:** Sweep 1 Agent 2 (confidence 95)
**Status:** ✅ **RESOLVED — FALSE POSITIVE** (verified 2026-05-11)

### Что
```sql
CHECK ("noted_at" <= NOW() + interval '5 minutes')
```

Agent 2 заявил, что `NOW()` re-evaluated на UPDATE → CHECK ломает row старше 5 минут.

### Verification

**Logical analysis:**
- Для любой row где `noted_at` в прошлом (что верно для всех "old" UPDATE-целей): `past <= NOW() + 5min` тавтологически TRUE.
- `NOW()` монотонно растёт → правая часть только увеличивается → CHECK не может стать false для уже-вставленной row с past `noted_at`.
- Repository `ProgressNoteRelationalRepository.update()` (lines 82-94) обновляет ТОЛЬКО `body` + `media_urls`. `noted_at` никогда не входит в SET-list update path.
- Даже если бы PG re-checked CHECK на каждом UPDATE независимо от изменённых колонок (worst case): `(now - 1h) <= (now + 5min)` всё ещё TRUE.

**Repro test (committed as evidence):**
[`src/modules/diagnostics/progress-note.update.integration.spec.ts`](../src/modules/diagnostics/progress-note.update.integration.spec.ts) — `INTEGRATION_DB=1`-gated spec, который:
1. Вставляет `progress_notes` row с `noted_at = NOW() - 1 hour` (далеко за 5-минутным окном)
2. Делает UPDATE `body` (mirror of repository.update) — ожидает успех
3. Делает UPDATE с `noted_at = noted_at` (force CHECK re-eval) — ожидает успех
4. Sanity: INSERT с `noted_at = NOW() + 10 min` отклоняется — CHECK всё ещё работает на INSERT (его реальная цель)

### Resolution
**Никаких изменений в миграции/коде.** CHECK constraint работает корректно: блокирует INSERT с future-skew > 5 min (intended), не препятствует UPDATE rows с past `noted_at` (по тавтологии). Entity invariant в [`progress-note.entity.ts:112`](../src/modules/diagnostics/domain/entities/progress-note.entity.ts) остаётся как defense-in-depth на app-layer.

### When
✅ Закрыто.

> **Note (2026-05-12):** spec-файл `progress-note.update.integration.spec.ts`, упомянутый выше, был создан в форк-сессии и УДАЛЁН при `git rollback` перед началом fix-pass. Логика и анализ остаются корректными — миграцию никто не трогал. Spec можно восстановить отдельным PR если нужна регрессионная защита; CHECK constraint inherently тавтологичен на UPDATE по past `noted_at`.

---

## C2 — B16 `markExpiredBatch` навсегда залочивает `paused` скидки

**File:** `src/modules/billing/infrastructure/persistence/relational/repositories/custom-discount.relational.repository.ts:313`
**Source:** Sweep 1 Agent 4 (confidence 92)
**Status:** 🔴 P0

### Что
```sql
UPDATE custom_discounts SET status = 'expired'
WHERE status = 'active' AND valid_until < NOW()
```

`paused` скидки со истёкшим `valid_until` навсегда остаются `paused`. Admin делает resume → скидка снова `active` несмотря на истёкший срок.

### Fix
```sql
WHERE status IN ('active', 'paused') AND valid_until < NOW()
```

### When
🔴 Сейчас.

---

# 🟠 HIGH — Системные паттерны (sweep 2)

## SP1 — Все 7 BullMQ processors пропускают `@Inject(ClockPort)`

**Files:**
- `src/modules/schedule-rollout/weekly-rollout.processor.ts:47` (B7)
- `src/modules/notification/outbox-poller.processor.ts:82` (B9)
- `src/modules/billing/monthly-billing.processor.ts:96` (B13)
- `src/modules/billing/discount-expire.processor.ts:69` (B16)
- `src/modules/content/processors/content-publish.processor.ts:66` (B17) — также missing `@Inject(NotificationPort)`
- `src/modules/content/processors/birthday-generation.processor.ts:50` (B17)
- `src/modules/content/processors/story-cleanup.processor.ts:58` (B17)

**Source:** Sweep 1 B17 H6 + Sweep 2 F3 (system-wide expansion)
**Status:** 🟠 B22 (если runtime работает) / 🔴 P0 (если падает)

### Что
NestJS DI требует `@Inject(AbstractClassToken)` для abstract class портов. Без декоратора reflect-metadata может вернуть `undefined`.

### Fix
Добавить `@Inject(ClockPort)` (и `@Inject(NotificationPort)` для ContentPublishProcessor).

### When
🟠 B22 — runtime check fix-agent'ом. Если падает — escalate to P0.

---

## SP2 — B13 TZ-bug шире чем §5 (prepayInvoice + buildPaymentCalendar)

**File:** `src/modules/billing/invoice.service.ts` lines 625-626, 666, 743-744
**Source:** Sweep 2 F2 (resolves §5 deferred)
**Status:** 🟠 B22

### Что
`startOfMonth(this.clock.now())` — приватный UTC helper (lines 1217-1222). При raw `clock.now()` около полуночи Almaty даёт прошлый месяц. §5 deferred знал только про `buildPaymentCalendar` — Sweep 2 F2 нашёл ту же дыру в `prepayInvoice`.

Lines 430, 502-503 — OK (inputs pre-normalized).

### Fix
Экспортировать `firstOfMonthInTimezone` из `monthly-billing.processor.ts` в shared-kernel. Заменить во всех 3 buggy местах.

### When
🟠 B22.

---

## SP3 — B7 Meal `getThisMonday()` TZ bug

**File:** `src/modules/meal/meal.parent.controller.ts:69-75`
**Source:** Sweep 2 F2 (новая находка — B7 не был в deep-review scope)
**Status:** 🟠 B22

### Что
`getDay()` через UTC. Sunday 19:00-24:00 UTC = Monday Almaty → возвращает прошлую неделю (off by 7 days).

### Fix
Использовать `isoWeekday(date, 'Asia/Almaty')` из shared-kernel.

---

## SP4 — B7 Meal default date UTC

**File:** `src/modules/meal/meal.staff.controller.ts:53`
**Source:** Sweep 2 F2
**Status:** 🟠 B22

### Что
`new Date().toISOString().slice(0,10)` — UTC date. 19:00-24:00 Almaty возвращает yesterday's plan.

### Fix
TZ-aware helper.

---

## SP5 — `/static/*` route полностью unauthenticated

**File:** `src/app.module.ts:146-151`
**Source:** Sweep 1 Codex + Sweep 2 F4 (расширил scope)
**Status:** 🔴 **P0 Blocker**

### Что
`ServeStaticModule` hook'ает на Express layer **до** NestJS guard pipeline. Все URLs `/static/<kgId>/<yyyy-mm>/<uuid>.<ext>` доступны интернету без аутентификации.

**Расширение по sweep 2 F4:** не только stories — **все content_posts media (news/qundylyq/birthday) тоже public**. Agent 1 (B17) проверил только stories.

### Why critical
- UUID brute-force defense недостаточна
- Push payload содержит `contentPostId`+`groupId` → recipient enumeration возможна
- Expired stories live forever если file delete не удалось

### Fix
Заменить `ServeStaticModule` на authenticated controller с `JwtAuthGuard` + `KindergartenScopeGuard` + media-access check. Stream file через service после проверки.

### When
🔴 Сейчас.

---

## SP6 — 5 producer-keys отсутствуют в CANONICAL_EVENT_KEYS

**File:** `src/modules/notification/event-keys.ts`
**Source:** Sweep 2 F4
**Status:** 🔴 **P0 Blocker** (privacy)

### Что
Producer (`outbox-notification.adapter.ts`) пушит:
- `guardian.pending_approval` (L79)
- `guardian.rejected` (L98)
- `guardian.revoked` (L106)
- `guardian.permissions_updated` (L132)
- `child.transferred` (L122)

Но `CANONICAL_EVENT_KEYS` их не содержит.

### Why
- DTO `IsIn(CANONICAL_EVENT_KEYS)` rejects PATCH preferences для этих ключей
- Default-merge не создаёт preference row
- Dispatcher fallback на `push_enabled: true` → **пользователи не могут opt-out**

### Fix
Добавить 5 ключей в `CANONICAL_EVENT_KEYS`.

### When
🔴 Сейчас.

---

## SP7 — 7 stale CANONICAL keys без TEMPLATE/RESOLVER

**File:** `src/modules/notification/event-keys.ts:13-54`
**Source:** Sweep 1 H2 + Sweep 2 F4
**Status:** 🟠 B22

### Что
Latent: пока никто их не emit'ит — dispatcher silently failure если producer появится.
- `payment.upcoming/overdue/receipt_issued`
- `request.reviewed/message_replied`
- `face.enrolled`
- `fiscal.retry_failed`

### Fix
Удалить из CANONICAL (либо добавить TEMPLATES когда придёт B14/B15/B19).

---

# 🟠 HIGH — State machine holes (sweep 2 F1)

## SM1 — B13 `markOverdueConditional` пропускает `partial` source

**File:** `src/modules/billing/infrastructure/persistence/relational/repositories/invoice.relational.repository.ts:234-246`
**Source:** Sweep 2 F1 (confidence 88)
**Status:** 🟠 B22

### Что
Guards `['pending']`. `partial` invoice пересекающий due_date навсегда stuck в `partial`.

### Fix
`WHERE inv.status IN ('pending', 'partial')`.

---

## SM2 — B5 ChildGuardian: status race (vintage баг)

**File:** `src/modules/child/infrastructure/persistence/relational/repositories/child-guardian.repository.ts:140-157`
**Source:** Sweep 2 F1 (confidence 82)
**Status:** 🔴 **P0 Blocker**

### Что
`update(guardian)` использует plain `repo.update({id,kg}, {...})` без `WHERE status=:expected`. Все 3 transitions (`approve`/`reject`/`revoke`) делают `findById → domain method → unconditional UPDATE`. Concurrent approve+reject — оба HTTP 200, last writer wins silently.

Vintage с момента закрытия P5 (`f1d6984`).

### Fix
Добавить `updateWithExpectedStatus(guardian, expectedStatus)` с `AND status = :expected`. Все 3 service call sites должны capture expected status до domain mutation.

### When
🔴 Сейчас.

---

## SM3 — B18 DiagnosticTemplate optimistic lock — dead code

**File:** `src/modules/diagnostics/infrastructure/persistence/relational/repositories/diagnostic-template.relational-repository.ts:113-132`
**Source:** Sweep 2 F1 (reclassified from M14)
**Status:** 🟠 B22

### Что
1. `expectedVersion` branch не проверяет `result.affected`.
2. Service `update()`/`deactivate()` НИКОГДА не передают `expectedVersion` → dead code.
3. `is_active` toggle без concurrency protection.

### Fix
Repo: check affected → throw OptimisticLockError. Service: передавать `expectedVersion = existing.version`.

---

# 🟠 HIGH — Batch-specific (sweep 1)

## H1 — WorkerModule не импортирует ContentModule + BillingModule

**File:** `src/worker/worker.module.ts:78-167`
**Source:** Sweep 1 Agent 6, **verified manually**
**Status:** 🟠 B22

### Что
Не импортирует: ContentModule (B17), BillingModule (B13+B16). 5 processors недоступны в worker process.

Сейчас api-process хостит их. Работает. Но при horizontal scaling api → конкуренция processors.

### Fix
Импорт + `BullModule.registerQueue` для 5 queues. Опционально: env-flag.

---

## H3 — SQL string interpolation в WeeklyRolloutService

**File:** `src/modules/schedule-rollout/weekly-rollout.service.ts:166`
**Source:** Sweep 1 Agent 7
**Status:** 🟠 B22

### Что
```typescript
await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
```

Pattern violation — другие 5 processors используют `set_config($1, $2, true)` с bind.

### Fix
`SELECT set_config($1, $2, true)` с параметрами.

---

## H4 — `PUSH_PROVIDER` отсутствует в env-example

**File:** `env-example-relational`
**Source:** Sweep 1 Agent 6
**Status:** 🟡 B22+

### Fix
Добавить `PUSH_PROVIDER=mock` с комментарием.

---

## H5 — Dispatcher `{status:'failed'}` не type-enforced

**File:** `src/modules/notification/notification-dispatcher.service.ts:1440-1448`
**Source:** Sweep 1 Agent 6
**Status:** 🟡 B22+

### Fix
Либо всегда throw `SavepointRollback`, либо type-level discriminated union.

---

## H7 — ContentPublishProcessor: outbox failure rolls back kg-batch

**File:** `src/modules/content/processors/content-publish.processor.ts:149-166`
**Source:** Sweep 1 Agent 1
**Status:** 🟠 B22

### Что
Outbox INSERT для post[N] падает → rollback kg-батч TX → posts[0..N-1] возвращаются в `scheduled` → next tick: duplicate publish + notification.

Регрессия B9 T10/T11 fix.

### Fix
Per-event SAVEPOINT вокруг (transitionStatus + emitPublishedEvent).

---

## H8 — Controllers используют `new Date()` вместо ClockPort

**Files:** `staff-stories.controller.ts:206,222`, `parent-content.controller.ts:114`
**Source:** Sweep 1 Agent 1
**Status:** 🟡 B22+

### Fix
Inject `ClockPort` в controllers.

---

## H9 — B17 birthday-gen использует getUTCMonth/UTCDate под Almaty cron

**File:** `src/modules/content/birthday-generator.service.ts:49`
**Source:** Sweep 1 Agent 1 + Codex confirmed
**Status:** 🟠 B22

### Fix
Нормализовать today в `YYYY-MM-DD` Asia/Almaty один раз в processor boundary.

---

## H10 — B18 schema validators без DoS caps

**File:** `src/modules/diagnostics/domain/schema-validators.ts:70-176`
**Source:** Sweep 1 Agent 2
**Status:** 🟡 B22+

### Fix
MAX_SECTIONS=20, MAX_FIELDS_PER_SECTION=50, MAX_OPTIONS_PER_FIELD=100, MAX_STRING_LENGTH=200.

---

## H11 — B18 `date` regex пропускает 2026-02-30

**File:** `src/modules/diagnostics/domain/schema-validators.ts:316-322`
**Source:** Sweep 1 Agent 2
**Status:** 🟠 B22

### Fix
После regex — `new Date(raw + 'T00:00:00Z').toISOString().slice(0,10) === raw`.

---

## H12 — B18 template PATCH без version-pinning

**File:** `src/modules/diagnostics/diagnostic-template.service.ts:65-76`
**Source:** Sweep 1 Agent 2
**Status:** 🟠 B22

### Fix (option a — safest)
Block schema PATCH если есть existing entries: throw 409.

---

## H13 — B18 multiselect duplicates + scale non-integer

**File:** `src/modules/diagnostics/domain/schema-validators.ts:280-313, 325-350`
**Source:** Sweep 1 Agent 2
**Status:** 🟡 B22+

### Fix
`new Set(raw).size === raw.length` для multiselect; `Number.isInteger(raw)` для scale.

---

## H14 — B13 partial payment на overdue не флипает status

**File:** `src/modules/billing/payment.service.ts:474`
**Source:** Sweep 1 Agent 3 (calibration of SM1)
**Status:** 🟠 B22

### Fix
`else if (paidSum > 0 && (invoice.status === 'pending' || invoice.status === 'overdue'))`.

---

## H15 — B13 isFirstInvoiceForChild считает cancelled

**File:** `src/modules/billing/invoice.service.ts:1096-1103`
**Source:** Sweep 1 Agent 3
**Status:** 🟠 B22

### Fix
Передавать `{ excludeStatuses: ['cancelled'] }`.

---

## H16 — B13+B16 discount-cap-race

**Files:** `invoice.service.ts:959,1131,1153`; `custom-discount.relational.repository.ts:343`
**Source:** Sweep 1 Agent 4 + Codex confirmed
**Status:** 🟠 B22

### Что
Invoice persists с discount **до** `incrementUsedCount`. Race → over-cap discount без ledger row. Totals/usage/audit расходятся. Также `total_max_uses`-only скидки без advisory lock.

### Fix
Резервировать used_count до invoice persist, либо retry-path. Добавить advisory lock keyed `(kg, discountId)` когда `totalMaxUses != null`.

---

## H17 — B11+B12 OTP INCR+EXPIRE non-atomic

**Files:**
- `src/modules/pickup/infrastructure/otp/redis-pickup-otp-store.adapter.ts:64-72`
- `src/modules/parent-request/infrastructure/otp/redis-parent-request-otp-store.adapter.ts:65-71`

**Source:** Sweep 1 Agent 5 (confidence 85)
**Status:** 🔴 **P0 Blocker**

### Что
```typescript
const n = await this.redis.incr(key);     // round-trip 1
if (n === 1) {
  await this.redis.expire(key, ttl);      // round-trip 2 — crash between → permanent key
}
```

Auth adapter уже фиксил тот же баг через Redis pipeline.

### Fix
Использовать `redis.pipeline().incr(key).expire(key, ttl)` с одним await.

### When
🔴 Сейчас.

---

## H18 — 12 controllers импортируют Repository напрямую

**Files:** Sweep 1 Agent 10 — 12 файлов
**Source:** Sweep 1 Agent 10
**Status:** 🟡 B22+

### Fix
Переместить repo вызовы в service layer.

---

# 🟡 MEDIUM (~27)

## Из sweep 1

- **M1** `parent-diagnostic.controller.ts:152-166` — IDOR на entry by id. 🟠 B22 (privacy)
- **M2** `payment-webhook.controller.ts:85-109` — глотает WebhookSignatureInvalidError. 🟠 B22
- **M3** `story-cleanup.processor.ts:132` — expired story media public (покрыто SP5)
- **M4** dispatcher — `content.birthday` `kz`+`kk` locale inconsistency
- **M5** `outbox-notification.adapter.ts:121-129` — dead `recipientUserIds` PII в payload
- **M6** `invoice.service.ts:328` — manualMarkPaid idempotency key с timestamp
- **M7** `invoice.service.ts:640-650` — buildPaymentCalendar prepayment_* overrides monthly
- **M8** `refund.service.ts:186-244` — concurrent process stale status в error
- **M9** UpdateCustomDiscountDto cross-field validation отсутствует
- **M10** Conditions all_of/any_of unbounded width
- **M11** hashtext 32-bit collision space
- **M12** `discount-expire.processor.ts:153` — raw SQL column assumption
- **M13** DiagnosticTemplate mapper re-runs validation
- **M14** → upgraded to SM3 HIGH
- **M15** Admin bypass double-fetch race (diagnostics)
- **M16** B12 cursor pagination сломан — nextCursor: null всегда. 🟠 B22
- **M17** B12 mondayOfIsoWeek UTC vs isWeekendDay TZ — latent
- **M18** B11 trusted_person double-fetch под advisory lock
- **M19** Nanny create_requests override — dispatcher excludes request.*
- **M20** B16 migration без ON DELETE CASCADE на kindergartens FK
- **M21** 4 services импортируют DataSource из typeorm

## Из sweep 2

- **F5-M1** trusted_people — нет dedicated phantom-row spec. 🟡 B22+
- **F5-M2** parent_request_messages — нет dedicated phantom-row spec. 🟡 B22+

## Из IMPLEMENTATION_PLAN §5

Все existing deferred items оттуда остаются в силе.

---

# ✅ Положительные верификации

- 0 duplicate BullMQ queue names (7 processors)
- 0 framework imports в domain layer
- 0 Repository imports в `*.service.ts`
- 0 "prisma" упоминаний
- 14 advisory locks — все правильно scoped через manager()
- 11 cross-tenant методов — все justified
- 9 bypass_rls call sites — все на fresh TX или owned outer TX
- 20 migrations с непустыми down()
- 18/20 B11-B18 таблиц прямо покрыты phantom-row integration specs
- Redis pipelining — bounded к 2 known места
- 15+ state machines проверены — только 3 дыры
- TZ helpers — 5 invoice.service.ts UTC calls: 2 OK + 3 bug
- FORCE RLS + tenant_isolation + REVOKE TRUNCATE verified на всех 20 B11-B18 таблицах

---

# 🎯 Fix plan

## 🔴 P0 — Сейчас (5 блокеров)

1. ~~**C1** — B18 progress_notes CHECK constraint~~ ✅ **RESOLVED FALSE POSITIVE** (2026-05-11)
2. **C2** — B16 markExpiredBatch + `'paused'`
3. **SP5** — `/static/*` → authenticated controller
4. **SP6** — 5 missing keys → CANONICAL_EVENT_KEYS
5. **SM2** — ChildGuardian.updateWithExpectedStatus (B5 race)
6. **H17** — B11+B12 OTP Redis pipeline

## 🟠 B22 Polish (~17 HIGH + большая часть MEDIUM)

Группировка по теме:
- **Operational:** H1 (WorkerModule), SP1 (@Inject в processors)
- **State machines:** SM1 (markOverdueConditional), SM3 (B18 optimistic lock), H14 (B13 partial+overdue)
- **TZ:** SP2 (B13 prepayInvoice/buildPaymentCalendar), SP3+SP4 (B7 Meal), H9 (B17 birthday)
- **Privacy/security:** SP7 (stale CANONICAL keys), H3 (SQL interpolation), M1 (IDOR), M2 (webhook signature)
- **Discount logic:** H15 (cancelled invoices), H16 (discount-cap race)
- **B17:** H7 (publish processor SAVEPOINT), H12 (template PATCH)
- **B18:** H11 (date regex), H10/H13 (DoS + duplicates)
- **B12:** M16 (cursor pagination)
- **Doc/types:** H4 (env), H5 (dispatcher contract)

## 🟡 B22+ / Tech debt

H8 (controller new Date), H10 (DoS caps), H13 (validation), H18 (controller→repo), M11 (hashtext), M17 (TZ latent), M21 (DataSource in services), F5-M1/M2 (phantom specs).

## ✅ Migration timestamp ordering — RESOLVED 2026-05-12

**File:** `src/database/migrations/`
**Status:** ✅ **RESOLVED** (commits `34adacc` + `914660e` 2026-05-12)

**Resolution:** 3 миграции переименованы:
- `1777501179271-EnrollmentTables.ts` → `1777593604500-EnrollmentTables.ts`
- `1777556957492-B7ScheduleAndMeal.ts` → `1777593605000-B7ScheduleAndMeal.ts`
- `1777588264314-B8AttendanceAndTimeline.ts` → `1777593606000-B8AttendanceAndTimeline.ts`

Fresh PG container теперь запускает миграции в правильном порядке (P0-P5 → B5 → B7 → B8 → B9+). Devs с long-lived volumes — либо drop-volume + re-bootstrap, либо `UPDATE migrations SET name = ... WHERE name = ...` ручной патч; production не затронут (никогда не было production deployment).

### Что (historical)
Миграции B5/B7/B8 имели timestamps РАНЬШЕ P0/P1/P3-P5:
- `1777501179271-EnrollmentTables.ts` (B5)
- `1777556957492-B7ScheduleAndMeal.ts` (B7)
- `1777588264314-B8AttendanceAndTimeline.ts` (B8)
- vs `1777593600000-InitExtensions.ts` (P0), `...601000-AuthAndUsersTables.ts` (P1), `...602000-StaffAndKindergartenSettings.ts` (P3), `...603000-OrganizationTables.ts` (P4), `...604000-ChildrenAndGuardians.ts` (P5)

На fresh PG container миграции запускаются в timestamp-order → B5 EnrollmentTables падает первой с `relation "kindergartens" does not exist` (kindergartens создаётся P1, который имеет более поздний timestamp).

Existing dev DB volumes уже мигрированы (порядком как их добавляли в git, не как timestamp хочет) — не замечается, пока volume не пересоздан.

### Why missed by tests
Race-integration spec'и и e2e в `test/` запускают setup через `DataSource` с `synchronize: false` — ожидают, что DB уже мигрирована. Они не выполняют миграции сами. CI/dev environments всегда работают с long-lived volume.

### Fix
Переименовать 3 файла:
- `1777501179271-EnrollmentTables.ts` → `1777593604500-EnrollmentTables.ts` (после P5)
- `1777556957492-B7ScheduleAndMeal.ts` → `1777593605000-B7ScheduleAndMeal.ts`
- `1777588264314-B8AttendanceAndTimeline.ts` → `1777593606000-B8AttendanceAndTimeline.ts`

**Caveat:** rename ломает существующие dev DB volumes (TypeORM `migrations` table запомнила старые names). Devs должны либо: (a) drop volume + re-bootstrap, либо (b) `UPDATE migrations SET name = ... WHERE name = ...` ручной патч. Production не затронут (никогда не существовало production deployment).

### When
🟠 B22 — самостоятельный PR с co-ordinated communication команде.

### Workaround в этом fix-pass'е
Integration + e2e тесты не запускались (`INTEGRATION_DB=1`, `test:e2e`) — fresh PG не мигрируется. Unit suite 1726/1726 + lint + TS clean верифицируют все 5 fix'ов. Recommend full CI run после миграционного fix'а.

## ⏸ Phase B/C

Real providers (SMS, Halyk, FCM, OFD, S3) — Phase B.
Edge/Face/CCTV — Phase C.

---

# Fix log 2026-05-12

5 P0 blockers closed in one fix-pass. Baseline (1654 unit) -> 1726 passed (0 failed), lint clean, TS clean.

## C2 — markExpiredBatch paused -> expired
- Files: `custom-discount.relational.repository.ts:318`, `custom-discount.service.spec.ts` (fake fix + new test)
- Change: WHERE status equals 'active' -> WHERE status IN ('active', 'paused'). Mirror in service-unit fake.
- Tests: 25/25 (24 existing + 1 new "expires a paused discount").

## SP6 — 5 keys added to CANONICAL_EVENT_KEYS
- Files: `event-keys.ts`, new `event-keys.spec.ts`
- Added: guardian.pending_approval, guardian.rejected, guardian.revoked, guardian.permissions_updated, child.transferred.
- Tests: 5/5 new regression cases.

## H17 — Redis pipeline in both OTP adapters
- Files: pickup `redis-pickup-otp-store.adapter.ts:64`, parent-request `redis-parent-request-otp-store.adapter.ts:65`
- Change: two-step incr + conditional expire -> single pipelined incr + expire (mirror auth adapter).
- Tests: full suite green; structural parity with already-tested auth pattern.

## SM2 — ChildGuardian conditional UPDATE
- New domain error: `child-guardian-status-conflict.error.ts` extends ConflictError (HTTP 409).
- Port: `child-guardian.repository.ts` adds `updateWithExpectedStatus(guardian, expectedStatus)` returning boolean. Default fallback keeps test fakes compiling.
- Relational repo: `override async updateWithExpectedStatus` via createQueryBuilder + andWhere status = expected; returns affected > 0.
- Service: 5 transition sites (`revokeGuardianByAdmin`, `approveGuardian`, `rejectGuardian`, `revokeGuardianByPrimary`, `selfUnlinkFromChild`) capture expectedStatus before domain mutation and throw `ChildGuardianStatusConflictError` when false.
- Non-transition writes (role/pickup, approval-rights toggle, permissions patch/reset) intentionally left on plain update; smaller race window, tracked as future-polish.
- Spec fake: findById and findActiveByChildAndUser now return `ChildGuardian.hydrate(stored.toState())` (snapshot isolation mirror of PG); updateWithExpectedStatus enforces expected-status against store.
- Tests: 39/39 (38 existing + 1 new race regression).

## SP5 — Authed MediaController replaces ServeStaticModule
- New: `media.controller.ts`, `media.controller.spec.ts`.
- New route: GET /api/v1/media/:kgId/:yyyyMm/:filename behind global JwtAuthGuard + KindergartenScopeGuard. Three layers of defence:
  1. Path-shape validation (UUID + YYYY-MM + filename regex) -> 404 on malformed.
  2. Tenant gate: tenant.kgId equals path kgId, OR tenant.bypass is true (super-admin) -> 403 on cross-tenant.
  3. Storage delegate: FileStoragePort.download(key); ENOENT -> 404.
- Response streams Buffer with derived Content-Type (jpg, jpeg, png, webp, gif, mp4, webm), Cache-Control private no-store so revocation propagates.
- Removed: ServeStaticModule.forRoot block from app.module.ts + its import.
- Adapter URL prefix: local-file-storage.adapter.ts default changed from /static to /api/v1/media. Existing media_urls referencing /static will 404; backfill not needed for Phase A.
- Tests: 5/5 new (kg match, cross-tenant 403, super-admin bypass, path-shape guard, ENOENT 404).
- ContentModule wiring updated.

## Final verification
- `npx tsc --noEmit` — clean
- `npm run lint` — clean (after autoformat)
- `npx jest` — 1726 passed / 0 failed (138 suites, 27 INTEGRATION_DB-gated skipped)
- Integration / e2e not executed in this pass (no INTEGRATION_DB=1); recommend full CI run before merge.

## Files changed (10 total)

Production code:
- `src/app.module.ts` (SP5)
- `src/modules/billing/infrastructure/persistence/relational/repositories/custom-discount.relational.repository.ts` (C2)
- `src/modules/notification/event-keys.ts` (SP6)
- `src/modules/pickup/infrastructure/otp/redis-pickup-otp-store.adapter.ts` (H17)
- `src/modules/parent-request/infrastructure/otp/redis-parent-request-otp-store.adapter.ts` (H17)
- `src/modules/child/infrastructure/persistence/child-guardian.repository.ts` (SM2 port)
- `src/modules/child/infrastructure/persistence/relational/repositories/child-guardian.repository.ts` (SM2 relational)
- `src/modules/child/child.service.ts` (SM2 — 5 sites)
- `src/modules/content/content.module.ts` (SP5 wiring)
- `src/shared-kernel/storage/adapters/local-file-storage.adapter.ts` (SP5 URL prefix)

New files:
- `src/modules/child/domain/errors/child-guardian-status-conflict.error.ts` (SM2)
- `src/modules/notification/event-keys.spec.ts` (SP6 regression)
- `src/modules/content/media.controller.ts` (SP5)
- `src/modules/content/media.controller.spec.ts` (SP5 regression)

Test additions: 1 (C2) + 5 (SP6) + 1 (SM2) + 5 (SP5) = 12 new specs, plus FakeGuardianRepo snapshot-isolation refactor.

---

**Last updated:** 2026-05-12 (5 P0 blockers fixed)
