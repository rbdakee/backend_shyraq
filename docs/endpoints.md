# Shyraq — Endpoints Specification

Документация всех ендпоинтов по четырём API, выведенная из `Shyraq BP.md`, `architecture.md` и `schema.dbml`. Только логика/контракт, без реализации.

Все API (кроме `/saas/*`) работают через `KindergartenScopeGuard` — `kindergarten_id` берётся из JWT и автоматически применяется к запросам. Все запросы проходят через `RateLimitInterceptor` (Redis sliding window).

Принятые соглашения:
- Ответы локализуются по `users.locale` (`ru` / `kk`) c fallback на RU.
- Presigned upload для медиа — через общий `StorageModule` (см. раздел Shared).
- OTP — через `AuthModule` (login) и `PickupModule` (доверенное лицо). Идентификация также возможна через Identity QR (fallback).

**Guards (cross-cutting):**
- `JwtAuthGuard` — валидирует Bearer access-токен, проверяет `token:blocklist:{jti}` через `TokenBlocklistPort`. Ставит `req.user = {user_id, role, kindergarten_id?, jti}`.
- `KindergartenScopeGuard` — для admin/staff API: читает `kindergarten_id` из JWT, строит `req.tenant = TenantContext{kgId, bypass:false}`. Для `@SuperAdminScope()`-помеченных controllers выполняет `bypass:true`.
- `ChildAccessGuard` (B4) — для Parent App routes c `:childId` (или `:id` в children-routes): извлекает `req.user.user_id`, ищет `child_guardians(child_id, user_id)` где `status='approved' AND revoked_at IS NULL`. **Cross-tenant lookup** (до tenant-resolve) — guard не имеет TenantContext до самого lookup'а; находит ребёнка → ставит `req.tenant = TenantContext{kgId: child.kindergarten_id, bypass:false}` и `req.guardianRecord = {role, permissions}` для downstream permission-checks. **Fallback:** если в URL есть `:guardianId` без `:childId` — резолвит ребёнка по `(guardianId, userId)` (нужно для `/parent/approvals/:guardianId/*`). Используется на всех `/parent/children/:id/*` и `/parent/approvals/:guardianId/*` endpoints.
- `@PrimaryGuardian()` (B4) — метаданный декоратор для approval-flow endpoints; проверяет `req.guardianRecord.role === 'primary'` после `ChildAccessGuard`, иначе 403 `not_primary_guardian`.

---

## 0. Shared / Cross-cutting

Ендпоинты, используемые из нескольких клиентов (Admin Web, Parent App, Staff App). Не относятся к SuperAdmin.

### 0.0 Infrastructure / Health

Публичные эндпоинты для liveness/readiness-проверок. Без auth, без `KindergartenScopeGuard`, без `RateLimitInterceptor`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | Liveness probe. Всегда `200 OK` пока процесс жив. Response: `{ status: 'ok', ts: '<ISO8601>' }`. Без внешних зависимостей. |
| GET | `/health/ready` | Readiness probe. Параллельный `PING` к PostgreSQL (`SELECT 1`) и Redis с timeout 1s каждый. `200 OK` если оба up: `{ status: 'ok', checks: { db: 'up', redis: 'up' } }`. `503 Service Unavailable` если хотя бы один down: `{ status: 'degraded', checks: { db: 'up'\|'down', redis: 'up'\|'down' } }`. |

### 0.1 Auth (OTP + JWT)

Parent/Staff идут через OTP по телефону. Access-токен — JWT (HS256, TTL 15m). Refresh-токен — **opaque random hex (32 bytes)**, в БД хранится только `token_hash = SHA256(raw)` в `refresh_tokens`; TTL `REFRESH_TOKEN_TTL_DAYS` (default 30). Ротация — `UPDATE revoked_at=NOW()` + insert new; старый access-`jti` — в `token:blocklist:{jti}` до исходного `exp`. Формат `jti` — uuid v4.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/otp/request` | Отправить OTP по номеру телефона. Валидация: phone `/^\+[1-9]\d{1,14}$/` (E.164 strict). Rate-limit 5/hour per phone (Redis `rate:otp:{phone}` TTL 3600с). Lockout-check: `otp:locked:{phone}` → 429 `otp_locked`. Генерит 6-digit код (или `OTP_TEST_CODE` для phone'ов из `OTP_TEST_PHONES`), пишет `otp:login:{phone}` Hash `{code, attempts:0}` TTL 300с. SMS отправляется через `SmsProvider` (mock-adapter логирует в stdout). Для whitelisted phone'ов SMS не отправляется. Response: `202 Accepted` — `{sent: true, resend_after_sec: 60}`. |
| POST | `/auth/otp/verify` | Проверить OTP. Читает `otp:login:{phone}` (missing → 400 `otp_expired_or_missing`); mismatch → `HINCRBY attempts`; at 3 → `SET otp:locked:{phone} TTL 900s` + `DEL otp:login:{phone}` → 429 `otp_locked`. Success → DEL, lookup/create user by phone. Выдача токенов зависит от ролевого резолва (см. ниже). |
| POST | `/auth/refresh` | Ротация refresh-токена. Body `{refresh_token}`. Lookup по `SHA256(refresh_token)`; проверка `revoked_at IS NULL AND expires_at > NOW()` (иначе 401 `invalid_refresh`). В одной TypeORM-транзакции: `UPDATE refresh_tokens SET revoked_at=NOW()` + `INSERT` новый; после commit — `SET token:blocklist:{old_access_jti}` с TTL = remaining access TTL (best-effort). Response — новая пара `{access_token, refresh_token}`. Клиент должен передать текущий access-токен в `Authorization: Bearer …` вместе с body refresh_token — без него blocklist пропускается (best-effort). |
| POST | `/auth/logout` | Bearer-protected. Revoke current refresh (`UPDATE revoked_at=NOW()` по `token_hash` из body, если передан; иначе ревокация по `user_id`). `SET token:blocklist:{current_access_jti}` TTL = remaining. Response `204 No Content`. Дозволен для JWT с `pending_role_select:true` (whitelist). |
| POST | `/auth/role/select` | Выбор активной роли/садика для Staff с 2+ активными `staff_members`. Требует JWT с claim `pending_role_select:true` (иначе 403 `role_select_not_required`). Body `{kindergarten_id}`; проверка `staff_members WHERE user_id=? AND kindergarten_id=? AND is_active=true` (иначе 403 `role_not_available`); issue новый access `{sub, role, kindergarten_id, jti}` + opaque refresh; старый временный access `jti` → `token:blocklist:{jti}`. Response = стандартный auth-response. **Родители НЕ используют этот endpoint** — у них JWT без `kindergarten_id`, tenant резолвится через `children.kindergarten_id` на каждом запросе (см. §4 "Guardian Permissions Matrix"). |

**Auth response shape** (возвращает `/auth/otp/verify`, `/auth/refresh`, `/auth/role/select`):

```jsonc
{
  "access_token": "eyJhbGciOi...",        // JWT, HS256, 15m
  "refresh_token": "3a7f...b2c1" | null,  // 64 hex chars; null, если pending_role_select=true
  "token_type": "Bearer",
  "expires_in": 900,                       // seconds of access_token TTL
  "pending_role_select": false,            // true у multi-role staff до /auth/role/select
  "roles": [
    { "role": "admin",  "kindergarten_id": "uuid", "group_id": null },
    { "role": "mentor", "kindergarten_id": "uuid", "group_id": "uuid" }
  ],
  "kindergartens": [
    { "id": "uuid", "name": "Солнышко", "slug": "sunshine" }
  ]
}
```

- `roles[]` — все активные роли пользователя (`staff_members.is_active=true` + `child_guardians.status='approved' AND revoked_at IS NULL`). Parent получает запись `{role:'parent', kindergarten_id: null}` даже если у него guardian-записи в разных садиках.
- `kindergartens[]` — уникальные садики из `roles[]`; для Parent без staff-ролей возвращается пустой массив.

**Ролевой резолв в `/auth/otp/verify`:**

1. Нет `staff_members.is_active=true` + хотя бы один approved `child_guardians` (или вообще никаких) → **Parent**. JWT `{sub, role:'parent', jti}` без `kindergarten_id`. Refresh выдан.
2. Ровно один `staff_members.is_active=true` → **Single-role staff**. JWT `{sub, role, kindergarten_id, jti}`. Refresh выдан с `kindergarten_id`.
3. Два и более `staff_members.is_active=true` → **Multi-role staff** (D2). JWT `{sub, role:'staff_multi_role', pending_role_select:true, jti}`. **Refresh не выдаётся** (`refresh_token: null`). Клиент обязан вызвать `/auth/role/select` для получения полной пары.
4. Staff с `is_active=false` на всех записях и без approved `child_guardians` → 403 `no_active_roles`.

**Auto-approve primary guardian:** после успешной OTP-верификации, до ролевого резолва, бэкенд через bypass_rls cross-tenant ищет `child_guardians (user_id=self, role='primary', status='pending_approval')` и переводит каждую в `approved` (`approved_by=user_id`, `has_approval_rights=true`). Это покрывает кейс «родитель регистрируется и одновременно был назначен primary при enrollment'е» — после verify в `roles[]` уже включён kg-scope, и Parent App видит ребёнка без явного approve-action.

**Error codes:**

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `otp_expired_or_missing` | `/auth/otp/verify`: ключа `otp:login:{phone}` нет |
| 400 | `invalid_otp` | `/auth/otp/verify`: mismatch (но attempts < 3) |
| 400 | `invalid_phone_format` | DTO validation: phone не E.164 |
| 401 | `invalid_refresh` | `/auth/refresh`: токен отозван, истёк или не найден |
| 401 | `invalid_token` | JwtAuthGuard: JWT битый или expired |
| 401 | `token_revoked` | JwtAuthGuard: `jti` в blocklist |
| 403 | `no_active_roles` | `/auth/otp/verify`: пользователь есть в `users`, но ни одной активной роли/guardian-привязки |
| 403 | `pending_role_select` | Доступ к endpoint'у (кроме `/auth/role/select`, `/auth/logout`) с JWT `pending_role_select:true` |
| 403 | `role_not_available` | `/auth/role/select`: переданный `kindergarten_id` не соответствует ни одной активной `staff_members` записи пользователя |
| 403 | `role_select_not_required` | `/auth/role/select` вызван с полноценным JWT (без `pending_role_select`) |
| 429 | `otp_rate_limit` | `/auth/otp/request`: превышен лимит 5/hour per phone |
| 429 | `otp_locked` | `/auth/otp/request` или `/auth/otp/verify`: активная запись `otp:locked:{phone}` |

### 0.2 Users — Me

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/users/me` | Профиль текущего юзера (`users` + `roles[]` + `kindergartens[]`). Shape `roles[]`/`kindergartens[]` идентичен auth-response §0.1. Bearer-protected, не требует `kindergarten_id` в JWT. Отклоняется (403 `pending_role_select`) если JWT имеет `pending_role_select:true`. |
| PATCH | `/users/me` | Обновить ФИО, `avatar_url`, `locale` (`ru`/`kk`), `iin`, `date_of_birth`. Валидация DTO: `full_name` — non-empty string до 255 chars; `avatar_url` — URL или null; `locale` — enum `'ru' \| 'kk'`; `iin` — `/^\d{12}$/` (Luhn-проверка контрольной цифры отложена, см. `IMPLEMENTATION_PLAN.md §8 Active`); `date_of_birth` — ISO date. Уникальность `iin` через PG unique-constraint (TypeORM `23505`) → 409 `iin_already_taken`. Смена `locale` применяется ко всем будущим push/WS/email. Также отклоняется (403) для JWT с `pending_role_select:true`. |
| GET | `/users/me/qr` | (B10) Возвращает текущий Identity QR. Сервер авто-refresh'ит токен: если активного нет или до `expires_at` осталось <1 часа — транзакционно ревокирует старый (`user_qr_tokens.revoked_at`), создаёт новый (TTL 24ч), обновляет Redis `qr:token:{token}`. Ответ: `{token, expires_at, qr_svg_url}`. **НЕ реализован в B1.** |

> Ручного refresh-endpoint'а (`POST /users/me/qr/refresh`) в MVP нет — обновление только серверное, автоматическое.

### 0.3 Push tokens (FCM/APNS)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/push-tokens` | Зарегистрировать device token: `token`, `platform` (`ios`/`android`), `app_version`. Upsert по `(user_id, token)`, `is_active=true`. Используется Parent App и Staff App. |
| DELETE | `/push-tokens/:id` | Отвязать device token (logout из этого устройства) — `is_active=false`. |

### 0.4 Notifications

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/notifications` | История уведомлений текущего юзера (пагинация по `created_at`, фильтр `event_key`, `unread_only`). Локализуется по `users.locale` с fallback на RU. |
| POST | `/notifications/:id/read` | `read_at=NOW()`. WS-broadcast `notification.read` в `user:{id}`. |
| POST | `/notifications/read-all` | Массовый `read_at=NOW()`. |
| GET | `/notifications/preferences` | Возвращает per-event настройки (`event_key`, `push_enabled`, `ws_enabled`). Отсутствующие записи считаются `true/true`. |
| PATCH | `/notifications/preferences` | Upsert записей в `notification_preferences` по `(user_id, event_key)`. Body: `[{event_key, push_enabled, ws_enabled}, ...]`. |

**Event catalog.** Полный справочник `event_key`, адресатов, каналов и payload схем — см. `architecture.md` §5.14 "Notification event catalog". Кратко — основные ключи: `attendance.checkin/checkout`, `payment.upcoming/overdue/receipt_issued`, `diagnostic.new`, `progress_note.new`, `pickup.otp_sent/validated`, `content.news_published/story_new/qundylyq_new/birthday`, `discount.activated`, `request.reviewed/message_replied`, `face.enrolled`, `fiscal.retry_failed`, `notification.read`, `qr.revoked`.

**Nanny policy:** guardian с `role='nanny'` получает только `attendance.*` и `pickup.*` (отбрасывается в `NotificationDispatcher`). Настройки в `/notifications/preferences` для остальных ключей игнорируются.

### 0.5 Storage (S3 presigned)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/storage/presigned-upload` | Получить `{upload_url, key, expires_in: 300}`. Валидация `contentType` по allowlist per `purpose` (avatar, child_photo, story, diagnostic_attachment, face_enrollment_video, chat_media). |
| POST | `/storage/confirm-upload` | Подтвердить загрузку: обновляет ссылку в целевой сущности (например, `children.photo_url`, `content_posts.media_urls[]`). |
| GET | `/storage/download/:key` | Presigned GET URL (TTL 3600с) для приватных файлов. |

### 0.6 WebSocket

Не REST. Подключение — `WS /ws?token={jwt}`. Gateway выполняет `JwtAuthGuard` на handshake и автоматически подписывает сокет на релевантные комнаты (на основе `child_guardians`, `group_mentors`, роли).

**Envelope** (одинаковый для всех событий):
```json
{ "type": "<event_key>", "kindergarten_id": "...", "emitted_at": "...", "payload": { ... } }
```

**Комнаты и типы событий:**

| Комната | События (`type`) |
|---|---|
| `user:{user_id}` | `notification.new`, `notification.read`, `qr.revoked` |
| `child:{child_id}` | `attendance.checkin`, `attendance.checkout`, `timeline.new`, `daily_status.updated`, `diagnostic.new`, `progress_note.new` |
| `group:{group_id}` | `activity_event.created/started/completed`, `story.new`, `content.published_for_group` |
| `group:{group_id}:location_changed` | `location_changed` → триггер для Parent App перезапросить `GET /parent/cctv/access` |

Полные payload-схемы и правила подписки — `architecture.md` §5.13 "WebSocket event catalog".

---

## 1. SuperAdmin API (`/saas/*`)

**Назначение:** управление SaaS-платформой (не одним садиком). Отдельная роль `super_admin` в таблице `saas_users`. Не использует `KindergartenScopeGuard` — tenant указывается явно в параметрах.

**Auth:** email + password (не OTP).

### 1.1 Auth

Email + password (не OTP). Access-токен — тот же JWT HS256 (`JWT_ACCESS_SECRET`, TTL 15m) с `role='super_admin'` (или `'support'`) и без `kindergarten_id`. Refresh-токен — opaque random hex 32 bytes, **хранится в отдельной таблице `saas_refresh_tokens`** (FK на `saas_users.id`, не на `users.id`). TTL тот же `REFRESH_TOKEN_TTL_DAYS`. Все `/saas/*` controllers помечаются декоратором `@SuperAdminScope()` (D6) — `KindergartenScopeGuard` через metadata разрешает выполнение без `kindergarten_id` и активирует RLS-bypass.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/saas/auth/login` | Публичный (`@Public()`). Body `{email, password}`. Lookup `saas_users WHERE email=? AND is_active=true`. `bcrypt.compare`; любой негативный исход (user не найден, wrong password, `is_active=false`) → 401 `invalid_credentials` без утечки причины. Rate-limit 10/hour per email. При успехе — issue JWT `{sub, role, jti}` (без `kindergarten_id`, без `pending_role_select`) + opaque refresh в `saas_refresh_tokens`. Response идентичен parent-auth-response §0.1 минус `kindergartens[]` (всегда пустой). |
| POST | `/saas/auth/refresh` | Аналогично `/auth/refresh`, но работает против `saas_refresh_tokens`. Error codes идентичны. Клиент должен передать текущий access-токен в `Authorization: Bearer …` вместе с body refresh_token — без него blocklist пропускается (best-effort). |
| POST | `/saas/auth/logout` | Аналогично `/auth/logout`, но ревокирует запись в `saas_refresh_tokens` + добавляет access-`jti` в общий `token:blocklist:{jti}`. |

### 1.2 Kindergartens (Tenants)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/saas/kindergartens` | Список всех садиков (с фильтрами: `plan`, `is_active`, поиск по имени). |
| POST | `/saas/kindergartens` | Атомарное создание tenant'а. Body: `{name, slug, address?, phone?, plan?, settings?, admin: {full_name, phone, locale?}}`. В одной TypeORM-транзакции: `kindergartens` insert + find-or-create `users` по `admin.phone` (если phone уже существует — переиспользуем `user_id`, имя/locale не меняем) + `staff_members` (role=`admin`, `is_active=true`). После commit — `SmsPort.send` welcome-SMS (best-effort, log-on-fail, транзакцию не откатывает). Response 201 `{kindergarten, staff_member, user}`. Ошибки: 400 (invalid slug/phone format), 409 `kindergarten_slug_taken`, 422 (validation). **Активация admin'а = welcome-SMS + обычный B1 OTP-flow** (см. §0.1 `/auth/otp/request`+`/auth/otp/verify`); отдельного invite-token / magic-link нет. |
| GET | `/saas/kindergartens/:id` | Подробности садика: настройки, подписка, статистика (кол-во детей, активных подписок). |
| PATCH | `/saas/kindergartens/:id` | Обновить `settings` (timezone, currency, late_pickup_fee_amount, otp_expiry_seconds, prepay скидки, payment_grace_days, fiscal-конфиг), `plan`, `is_active`. |
| DELETE | `/saas/kindergartens/:id` | Soft-delete (через `is_active=false`), cascade-архивация активных сущностей. |

### 1.3 SaaS Subscriptions

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/saas/saas-subscriptions` | Список подписок платформы по садикам. |
| POST | `/saas/saas-subscriptions` | Создать подписку (`plan_code`, `billing_period`, `amount`, `started_at`). |
| PATCH | `/saas/saas-subscriptions/:id` | Изменить статус (`active`/`trial`/`suspended`/`cancelled`), `next_billing_at`. |

### 1.4 Feature Flags

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/saas/feature-flags` | Все флаги (глобальные + per-tenant). Фильтр по `kindergarten_id`. |
| POST | `/saas/feature-flags` | Создать/обновить флаг (`key`, `value` JSONB, опционально `kindergarten_id=null` — глобальный). |
| DELETE | `/saas/feature-flags/:id` | Удалить флаг. |

### 1.5 SaaS Users

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/saas/users` | Список SaaS-пользователей (super_admin, support). |
| POST | `/saas/users` | Создать SaaS-пользователя. |
| PATCH | `/saas/users/:id` | Деактивация, смена роли. |

---

## 2. Admin API (Admin Web, роль `admin`)

**Назначение:** управление конкретным садиком. JWT содержит `kindergarten_id`. Все запросы скоупятся автоматически.

### 2.1 Kindergarten Settings (own tenant)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/kindergarten` | Настройки своего садика (subset — без sensitive fiscal keys). |
| PATCH | `/admin/kindergarten` | Обновить name, address, phone, `settings` (кроме fiscal — только super_admin). |

### 2.2 Staff Management

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/staff` | Список сотрудников (фильтр по `role`, `is_active`, `specialist_type`). |
| POST | `/admin/staff` | Создать сотрудника: body `{full_name, phone, role, specialist_type?, group_id?, hired_at?}`. В одной TX: find-or-create `users` по phone (reuse если существует — паттерн B2 D10 L3, имя/локаль не меняются); insert `staff_members(role, is_active=true, specialist_type?, hired_at?)`; если `role=mentor` и передан `group_id` — в той же TX insert `group_mentors(is_primary = не-exists active primary)`. После commit — best-effort welcome-SMS «Ваш аккаунт в "<kg_name>" готов. Войдите в Staff App по номеру <phone>» через `SmsPort` (не откатывает TX, logged on fail). **Никакого invite-токена / magic-link** — активация через обычный OTP §0.1. 400 `invalid_specialist_type`, 400 `role_not_assignable` (например `reception` с `group_id`, или `role=specialist` без `specialist_type`), 404 `group_not_found`, 409 `staff_phone_conflict` (уже active staff в этом садике), 409 `mentor_one_active_group_violation` (гонка partial idx). |
| GET | `/admin/staff/:id` | Детали сотрудника + активные группы (для mentor'ов — `assigned_groups[]` с `is_primary`). 404 `staff_not_found`. |
| PATCH | `/admin/staff/:id` | Обновить `full_name?`, `role?`, `specialist_type?`, `hired_at?`, `fired_at?`. Валидация role×specialist_type matrix (D4 whitelist `psychologist`/`speech_therapist`/`music_teacher`/`physical_ed`/`nutritionist`): `role=mentor` → `specialist_type=null`; `role=specialist` → `specialist_type` обязателен и в whitelist; `role=admin`/`reception` → `specialist_type=null`. Если текущая `role=mentor` и новая `role != mentor` — в той же TX `UPDATE group_mentors SET unassigned_at=NOW() WHERE staff_member_id=? AND unassigned_at IS NULL` (**D5** auto-close, история сохраняется). 404 `staff_not_found`, 400 `invalid_specialist_type`, 400 `role_not_assignable`. |
| POST | `/admin/staff/:id/deactivate` | В одной TX: `is_active=false` + `UPDATE group_mentors SET unassigned_at=NOW() WHERE staff_member_id=? AND unassigned_at IS NULL` + `UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=? AND kindergarten_id=? AND revoked_at IS NULL`. Idempotent: повторный вызов при уже inactive → 409 `staff_inactive`. 404 `staff_not_found`. |
| POST | `/admin/staff/:id/activate` | Симметричная операция: `is_active=true`. **НЕ восстанавливает прошлые `group_mentors`** — admin заново делает assign через `/groups/assign`. Idempotent для уже active (200). 404 `staff_not_found`. |
| POST | `/admin/staff/:id/groups/assign` | Body `{group_id}`. Назначить mentor на группу. Validate: staff `role=mentor` + `is_active=true`, group `is_active=true`, `staff.kindergarten_id == group.kindergarten_id`. В TX: close active assignment (`UPDATE group_mentors SET unassigned_at=NOW()`) → определить `is_primary` (true если в группе нет активного primary) → insert `group_mentors(is_primary, assigned_at=NOW())`. Partial idx `idx_group_mentors_one_active` защищает инвариант «один mentor — одна активная группа»; при гонке `P2002` → retry 1 раз в use-case, иначе 409 `mentor_one_active_group_violation`. 404 `staff_not_found`/`group_not_found`, 400 `role_not_assignable` (staff не mentor), 409 `staff_inactive`. |
| POST | `/admin/staff/:id/groups/:groupId/primary` | Сменить primary mentor группы. Validate: staff `role=mentor` + `is_active=true`, group `is_active=true`, staff уже активно назначен в этой группе. В TX: снять `is_primary=false` у текущего primary → `is_primary=true` у целевого. Partial idx `idx_group_mentors_one_primary_per_group` защищает инвариант; при гонке P2002 → 409 `group_primary_conflict`. 404 `staff_not_found`/`group_not_found`, 400 `role_not_assignable`, 409 `staff_inactive`. |

**Error codes (§2.2):** `staff_not_found`(404), `staff_phone_conflict`(409), `staff_inactive`(409), `invalid_specialist_type`(400), `role_not_assignable`(400), `mentor_one_active_group_violation`(409), `group_primary_conflict`(409), `group_not_found`(404).

**Welcome-SMS (§2.2).** Отправляется best-effort после успешного `POST /admin/staff`, не откатывает транзакцию (аналог B2 D10 L2). `SmsPort.send` — тот же mock-провайдер, что для OTP, real-provider подключится в Active `SMS_PROVIDER`. Текст локализуется по `users.locale` (`kk`/`ru`/`en`). Staff-член активируется обычным OTP-flow `/auth/otp/request` → `/auth/otp/verify`; JWT выдаёт текущую `role` + `kindergarten_id` (single-role path) или `pending_role_select=true` (multi-role, B1 D2) если у телефона активны staff-записи в нескольких садиках.

### 2.3 Groups

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/groups` | Список групп + текущая локация (если есть), кол-во **активных** детей, active mentor(ы) с `is_primary`. |
| POST | `/admin/groups` | Создать: body `{name, capacity, age_range_min, age_range_max, current_location_id?}` (age — в месяцах). 400 `invalid_age_range` (min ≥ max), 404 `location_not_found` (если `current_location_id` передан и не существует / cross-tenant). |
| GET | `/admin/groups/:id` | Детали: группа + active mentors (`[{staff_member_id, full_name, is_primary}]`) + `current_location`. **В B3 без `children[]`** — поле отложено до B4 (вместе с ChildModule). 404 `group_not_found`. |
| PATCH | `/admin/groups/:id` | Обновить `name?`, `capacity?`, `age_range_min?`, `age_range_max?`, `current_location_id?`. 404 `group_not_found`, 400 `invalid_age_range`, 404 `location_not_found`. |
| POST | `/admin/groups/:id/deactivate` | Pre-check: `ChildRepository.countActiveByGroup(kgId, groupId) > 0` → 409 `group_has_active_children` (**D6** — admin сначала переводит детей через §12.2). В TX: `UPDATE groups SET is_active=false` + `UPDATE group_mentors SET unassigned_at=NOW() WHERE group_id=? AND unassigned_at IS NULL` (mentors освобождаются, инварианты `idx_group_mentors_one_active`/`one_primary_per_group` сохраняются). Idempotent для уже inactive (200). 404 `group_not_found`. |
| GET | `/admin/groups/:id/children` | **Deferred to B4** (вместе с ChildModule). В B3 endpoint не реализован и не документируется в Swagger. |
| GET | `/admin/groups/:id/mentor-history` | История назначений менторов: `[{staff_member_id, full_name, assigned_at, unassigned_at, is_primary}]` в хронологическом порядке DESC. 404 `group_not_found`. |

**Error codes (§2.3):** `group_not_found`(404), `group_has_active_children`(409), `invalid_age_range`(400), `location_not_found`(404).

### 2.4 Locations

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/locations` | Список локаций садика. |
| POST | `/admin/locations` | Создать: body `{name, description?}`. |
| PATCH | `/admin/locations/:id` | Обновить `name?`, `description?`. 404 `location_not_found`. |
| DELETE | `/admin/locations/:id` | Hard delete (у таблицы `locations` нет `is_active` — это CRUD-сущность). Pre-check FK references: `groups.current_location_id = :id`, `cameras.location_id = :id`, `activity_events.location_id = :id`, `schedule_template_slots.location_id = :id`. Если найдены активные ссылки → 409 `location_in_use`. 404 `location_not_found`. |

**Error codes (§2.4):** `location_not_found`(404), `location_in_use`(409).

### 2.5 Cameras (CCTV config)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/cameras` | Список камер (с relation `location`). Фильтр `?location_id=`. |
| POST | `/admin/cameras` | Создать: body `{location_id, name, stream_url?}` (внутренний RTSP `rtsp://mediamtx:8554/cam-{id}` — формируется на стороне B20 если не передан). Validate: `location` существует и принадлежит этому садику (иначе 404 `location_not_found` — не 403, чтобы не leak'ать cross-tenant существование). |
| PATCH | `/admin/cameras/:id` | Обновить `name?`, `stream_url?`, `location_id?`. 404 `camera_not_found`, 404 `location_not_found`. |
| DELETE | `/admin/cameras/:id` | Hard delete. 404 `camera_not_found`. |
| POST | `/admin/cameras/:id/test` | **Deferred to B20** (MediaMTX probe — только вместе с auth_request / Redis-токен-сторой). В B3 endpoint не реализован и не документируется в Swagger. |

**Error codes (§2.5):** `camera_not_found`(404), `location_not_found`(404).

### 2.6 Enrollments (Leads)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/enrollments` | Список лидов (фильтр по `status`, поиск по телефону/ФИО). |
| POST | `/admin/enrollments` | Создать лид вручную (`contact_name`, `contact_phone`, `child_name`, `child_dob`, `source`). Стартовый статус — `new`. |
| GET | `/admin/enrollments/:id` | Детали лида + `enrollment_status_log`. |
| PATCH | `/admin/enrollments/:id` | Обновить контактные данные. |
| POST | `/admin/enrollments/:id/transition` | Смена статуса (state machine: new→in_processing→{waitlist|card_created|cancelled}→archive). Логирует в `enrollment_status_log`. При `card_created` — создаётся `children` + `child_guardians` (primary) + первый `invoice`. |
| POST | `/admin/enrollments/:id/assign` | Назначить ответственного (`assigned_to=staff_member_id`). |

### 2.7 Children

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/children` | Список (фильтр по `status`, `current_group_id`, поиск по ФИО/ИИН). |
| POST | `/admin/children` | Создать карточку вручную (вне enrollment flow). |
| GET | `/admin/children/:id` | Полная карточка: гардианы, группа, история групп, timeline (preview), платежи (preview), диагностики (preview). |
| PATCH | `/admin/children/:id` | Обновить ФИО, ИИН, DOB, photo, `medical_notes`, `allergy_notes`. |
| POST | `/admin/children/:id/transfer-group` | Перевод в другую группу. Создаёт запись в `child_group_history`. |
| POST | `/admin/children/:id/archive` | `status='archived'`, `archived_at=NOW()`, `archive_reason`. Закрывает активные `tariff_assignments`, enqueue `billing:pro-rata`. **[Deferred to B21 — связано с tariff_assignments + pro-rata refund]** |
| POST | `/admin/children/:id/reactivate` | Возврат в `active`, открытие нового `tariff_assignment`. **[Deferred to B21]** |
| GET | `/admin/children/:id/guardians` | Все guardians ребёнка (+ статус одобрения, `has_approval_rights`). |
| POST | `/admin/children/:id/guardians` | Добавить guardian вручную (админ может создать primary с самого начала). |
| PATCH | `/admin/children/:id/guardians/:guardianId` | Изменить `role`, `can_pickup`. Изменение `has_approval_rights` — только через Primary Guardian's approval flow (см. Parent API). |
| POST | `/admin/children/:id/guardians/:guardianId/revoke` | Отозвать доступ (`revoked_at`, `revoked_by`). |
| GET | `/admin/children/:id/group-history` | История переводов. |
| GET | `/admin/children/:id/timeline` | Вся timeline ребёнка. **[Deferred to B8 — timeline появляется в Attendance batch]** |

### 2.8 Schedule (Templates + Activity Events)

**Auth:** `admin` role, `kindergarten_id` в JWT.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/schedule/templates` | Список шаблонов. Query: `group_id?`, `is_active?`. Response: `[{id, name, group_id, recurrence, is_active, valid_from, valid_until, slots_count}]`. |
| POST | `/admin/schedule/templates` | Создать шаблон. Body: `{group_id?, name, recurrence='weekly', valid_from, valid_until?}`. Response 201: полный объект шаблона. Errors: 400 `invalid_date_range`, 404 `group_not_found`. |
| PATCH | `/admin/schedule/templates/:id` | Обновить `name?`, `is_active?`, `valid_until?`. Errors: 404 `schedule_template_not_found`. |
| GET | `/admin/schedule/templates/:id/slots` | Слоты шаблона, отсортированные по `day_of_week`, `start_time`. Response: `[{id, day_of_week, start_time, end_time, activity_name, location_id, description}]`. Errors: 404 `schedule_template_not_found`. |
| POST | `/admin/schedule/templates/:id/slots` | Добавить слот. Body: `{day_of_week, start_time, end_time, activity_name, location_id?, description?}`. `day_of_week` — enum `mon|tue|wed|thu|fri|sat|sun`. Response 201. Errors: 404 `schedule_template_not_found`, 404 `location_not_found`, 409 `slot_time_conflict` (partial-unique `(template_id, day_of_week, start_time)`). |
| PATCH | `/admin/schedule/templates/:id/slots/:slotId` | Обновить поля слота. Errors: 404 `schedule_template_not_found`, 404 `slot_not_found`, 409 `slot_time_conflict`. |
| DELETE | `/admin/schedule/templates/:id/slots/:slotId` | Удалить слот. Errors: 404 `schedule_template_not_found`, 404 `slot_not_found`. |
| GET | `/admin/schedule/week-snapshots` | Флаги наличия расписания по неделям. Query: `group_id?`, `week_start_date_from?`, `week_start_date_to?`. Response: `[{id, group_id, week_start_date, source, copied_from?}]`. |
| POST | `/admin/schedule/week-snapshots/copy` | Ручной запуск копирования расписания с указанной недели на следующую (то что делает cron `schedule:auto-copy`). Body: `{group_id, source_week_start_date}`. Идемпотентен: если снапшот уже существует — возвращает 200 с существующим. Response: `{snapshot, activity_events_created: N}`. Errors: 404 `group_not_found`, 404 `source_week_snapshot_not_found`. |
| GET | `/admin/schedule/activity-events` | Список `activity_events`. Query: `group_id?`, `date_from`, `date_to`, `status?`. Response: `[{id, group_id, template_slot_id?, activity_name, location_id?, starts_at, ends_at?, status, created_by?, notes?}]`. |

**Error codes (§2.8):** `schedule_template_not_found`(404), `slot_not_found`(404), `slot_time_conflict`(409), `source_week_snapshot_not_found`(404), `invalid_date_range`(400), `group_not_found`(404), `location_not_found`(404).

#### 2.8.1 Weekly auto-copy rollout (super-admin)

**Auth:** `super_admin` only — endpoint iterates EVERY active kindergarten. Per-kg admin path lives at `POST /admin/schedule/week-snapshots/copy` (§2.8) and `POST /admin/meal-plans/copy-week` (§2.9).

**Cron `schedule:weekly-rollout`** (каждое воскресенье 23:00 Asia/Almaty, `@Cron('0 23 * * 0', { timeZone: 'Asia/Almaty' })`): для каждого активного `kindergartens` row — `ScheduleService.copyWeekToNext` + `MealService.copyWeekMenuToNext`. RLS-context устанавливается per-kg через `SET LOCAL app.kindergarten_id` внутри отдельной транзакции; список активных садиков читается под `bypass_rls=true`. Идемпотентен на уровне обоих сервисов.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/admin/schedule/week-rollout/run` | Ручной запуск cron'а `schedule:weekly-rollout` (schedule + meal copy для всех активных садиков). Body: `{from_monday?: string}` — опционально; если не передан, сервер вычисляет понедельник текущей Almaty-недели. Response: `{from_monday, source: 'manual', kindergartens: [{kindergarten_id, name, schedule: {copied_groups, skipped_groups, total_events}, meal: {plans_created, plans_skipped}, error?}], totals: {kindergartens, copied_groups, skipped_groups, total_events, plans_created, plans_skipped, errors}}`. Идемпотентен. |

### 2.9 Meal Plans

**Auth:** `admin` role, `kindergarten_id` в JWT.

**Cron `meal:auto-copy`** (каждое воскресенье 23:00 Asia/Almaty, `@Cron('0 23 * * 0')`): для каждого садика — если на следующую ПН–ПТ нет `meal_plans` → копирует из текущей недели со сдвигом +7 дней (`source='auto_copied_from_previous_week'`, `copied_from` = id оригинала). Идемпотентен: если план уже существует на эту дату → пропускает.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/meal-plans` | Меню по диапазону дат. Query: `date_from`, `date_to`, `group_id?`. Response: `[{id, date, group_id?, is_published, source, copied_from?, items: [...]}]` с `meal_items` вложенно. |
| POST | `/admin/meal-plans` | Создать `meal_plan`. Body: `{date, group_id?}`. Response 201. Errors: 409 `meal_plan_already_exists` (unique `(kg, date, group_id)`), 404 `group_not_found`. |
| PATCH | `/admin/meal-plans/:id` | Обновить `is_published?`, `notes?`. Errors: 404 `meal_plan_not_found`. |
| DELETE | `/admin/meal-plans/:id` | Удалить (каскадно удаляет `meal_items`). Errors: 404 `meal_plan_not_found`. |
| POST | `/admin/meal-plans/:id/items` | Добавить блюдо. Body: `{meal_type, dish_name: {ru, kz}, description?: {ru, kz}, allergens?: string[], calories?: int, photo_url?: string, position?: int}`. `meal_type` — enum `breakfast|snack_am|lunch|snack_pm|dinner`. Response 201. Errors: 404 `meal_plan_not_found`, 400 `invalid_meal_type`. |
| PATCH | `/admin/meal-plans/:id/items/:itemId` | Обновить поля блюда. Errors: 404 `meal_plan_not_found`, 404 `meal_item_not_found`. |
| DELETE | `/admin/meal-plans/:id/items/:itemId` | Удалить блюдо. Errors: 404 `meal_plan_not_found`, 404 `meal_item_not_found`. |
| POST | `/admin/meal-plans/copy-week` | Ручной запуск copy-week (аналог cron). Body: `{source_week_start_date}` — понедельник источника; копирует ПН–ПТ на следующую неделю. Идемпотентен. Response: `{plans_created: N, plans_skipped: N}`. |

**Error codes (§2.9):** `meal_plan_not_found`(404), `meal_plan_already_exists`(409), `meal_item_not_found`(404), `invalid_meal_type`(400), `group_not_found`(404).

### 2.10 Content

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/content` | Список постов (фильтр: `content_type`, `status`, `target_type`). |
| POST | `/admin/content` | Создать пост (news/qundylyq/schedule_pub/birthday): `title_i18n`, `body_i18n`, `media_urls[]`, `target_type` (all/group/child), `target_group_id` / `target_child_id`, `scheduled_for` (опц. — отложенная публикация), `status`. |
| GET | `/admin/content/:id` | Детали. |
| PATCH | `/admin/content/:id` | Обновить. |
| POST | `/admin/content/:id/publish` | `status='published'`, `published_at=NOW()`. Broadcast push в target-аудиторию. |
| DELETE | `/admin/content/:id` | Удалить (или `status='draft'`). |
| GET | `/admin/content/birthdays/upcoming` | Ближайшие дни рождения детей. |
| POST | `/admin/content/birthdays/:childId/schedule` | Запланировать поздравительный пост (cron `content:birthday-gen` автосоздаёт при отсутствии). |

### 2.11 Qundylyq (подтип content)

Используются `/admin/content` с `content_type='qundylyq'`. Выделенные helpers:

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/qundylyq/current` | Текущий активный Qundylyq (тема месяца). |
| POST | `/admin/qundylyq` | Публикация новой темы месяца. |

### 2.12 Payments & Invoices (просмотр)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/invoices` | Список инвойсов (фильтры: `status`, `due_date`, `child_id`, `invoice_type`). |
| GET | `/admin/invoices/:id` | Детали инвойса + `invoice_line_items` + связанные `payments`, `refunds`, `fiscal_receipts`, применённые `custom_discount_applications`. |
| POST | `/admin/invoices/:id/manual-mark-paid` | Ручная отметка оплаты наличкой (`provider='cash'`). |
| POST | `/admin/invoices/:id/cancel` | Отменить инвойс (`status='cancelled'`). |
| POST | `/admin/invoices` | Разовое начисление (доп. услуга): создаёт `invoices` + `invoice_line_items`. |
| GET | `/admin/payments` | Список платежей (фильтр: `provider`, `status`, `child_id`, диапазон дат). |
| GET | `/admin/payments/:id` | Детали (включая `provider_payload`). |

### 2.13 Tariffs (Billing)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/tariff-plans` | Список тарифов. |
| POST | `/admin/tariff-plans` | Создать: `name`, `tariff_type` (monthly_base/additional_service/late_pickup/meal_upgrade), `amount`, `applies_to` (child/group/age_range), `age_min/max_months`, `group_id`, `discount_rules` (sibling/prepay_3m/6m/12m/24m опционально, benefit_category), `valid_from/until`. Админ может задать долгий горизонт предоплаты через `discount_rules.prepay_24m_pct` — используется при `POST /parent/invoices/:id/pay/prepayment` с `months=24`. |
| PATCH | `/admin/tariff-plans/:id` | Обновить. |
| POST | `/admin/tariff-plans/:id/deactivate` | `is_active=false`. |
| GET | `/admin/tariff-assignments` | Назначения тарифов на детей. |
| POST | `/admin/tariff-assignments` | Назначить тариф ребёнку: `child_id`, `tariff_plan_id`, `custom_amount` (льгота), `custom_reason`, `valid_from/until`. |
| PATCH | `/admin/tariff-assignments/:id` | Обновить / закрыть. |

### 2.14 Kindergarten Holidays

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/holidays` | Список праздников/нерабочих дней. |
| POST | `/admin/holidays` | Создать: `date`, `name` {ru,kz}, `is_billable`. Используется для pro-rata. |
| PATCH | `/admin/holidays/:id` | Обновить. |
| DELETE | `/admin/holidays/:id` | Удалить. |

### 2.15 Refunds

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/refunds` | Список возвратов (фильтр по `status`). |
| GET | `/admin/refunds/:id` | Детали. |
| POST | `/admin/refunds` | Создать возврат: `payment_id`, `amount`, `reason`. Статус `pending`. |
| POST | `/admin/refunds/:id/process` | Подтвердить и обработать через провайдера. `status='processed'` или `failed`. |
| POST | `/admin/refunds/:id/cancel` | Отменить pending возврат. |

### 2.16 Custom Discounts

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/custom-discounts` | Список (фильтры по статусу, периоду). |
| POST | `/admin/custom-discounts` | Создать (`status='draft'`): `name` {ru,kz}, `description`, `discount_type` (percentage/fixed_amount), `amount`, `conditions` JSONB (prepayment_months / siblings_count / age_range / benefit_category / payment_method / early_payment / birthday_month / date_range / first_invoice / all_of / any_of), `target_type` + `target_ids[]`, `valid_from/until`, `max_uses_per_child`, `total_max_uses`, `priority`, `stackable`, `notify_on_activation`, `notification_title/body_i18n`. |
| GET | `/admin/custom-discounts/:id` | Детали + статистика применений. |
| PATCH | `/admin/custom-discounts/:id` | Обновить (только для `draft`). |
| POST | `/admin/custom-discounts/:id/activate` | `status='active'`. Если `notify_on_activation` — enqueue `discount:notify` (push всем target-родителям). |
| POST | `/admin/custom-discounts/:id/pause` | `status='paused'`. |
| POST | `/admin/custom-discounts/:id/cancel` | `status='cancelled'`. |
| GET | `/admin/custom-discounts/:id/applications` | Лог применений (`custom_discount_applications` с `invoice_id`, `child_id`, `amount_applied`). |

### 2.17 Fiscal Receipts (ОФД РК)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/fiscal-receipts` | Список чеков (фильтр по `status`, `provider`, `payment_id`, `fiscal_sign`). |
| GET | `/admin/fiscal-receipts/:id` | Детали + `ofd_payload`. |
| POST | `/admin/fiscal-receipts/:id/retry` | Ручной retry для `status='failed'`. Enqueue `fiscal:retry` (BullMQ с экспоненциальным backoff). Инкремент `retry_count`. |
| GET | `/admin/fiscal-receipts/queue` | Очередь pending/failed с ошибками (последний `error_message`, `retry_count`). |
| GET | `/admin/fiscal-receipts/report/monthly` | Ежемесячный отчёт по выданным чекам (totals, по провайдерам). |

### 2.18 Parent Requests (admin review)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/parent-requests` | Все заявки родителей (фильтр: `status`, `request_type`, `child_id`). Админ видит `open_request` с `recipient_type='admin'`. |
| GET | `/admin/parent-requests/:id` | Детали + `parent_request_messages`. |
| POST | `/admin/parent-requests/:id/review` | Accept / reject / note (`reviewed_by`, `reviewed_at`, `review_note`). |
| POST | `/admin/parent-requests/:id/messages` | Ответить в треде заявки. |

### 2.19 Diagnostic Templates

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/diagnostic-templates` | Список шаблонов (фильтр по `specialist_type`). |
| POST | `/admin/diagnostic-templates` | Создать: `specialist_type`, `name`, `schema` JSONB (sections → fields с required/type). |
| GET | `/admin/diagnostic-templates/:id` | Подробности. |
| PATCH | `/admin/diagnostic-templates/:id` | Обновить (auto-bump `version`). |
| POST | `/admin/diagnostic-templates/:id/deactivate` | `is_active=false`. |

### 2.20 Face ID Management

**Enrollment происходит ТОЛЬКО в садике** (admin-side) — это единственный путь в MVP. Parent App не имеет endpoint'ов для enrollment (см. §4.11). До enrollment обязательна фиксация consent (закон РК о биометрии).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/face-profiles` | Список активных профилей (фильтр: `subject_type`, `subject_id`). |
| POST | `/admin/face-enrollment-consents` | Зафиксировать согласие перед enrollment: `subject_type` (`child`/`guardian`/`staff`), `subject_id`, `signature_url` (S3 key скана подписанного согласия). `captured_by_staff_id`=актуальный админ, `captured_at=NOW()`. Возвращает `consent_id`. |
| GET | `/admin/face-enrollment-consents` | Список (фильтр: `subject_type`, `subject_id`, `revoked`). |
| POST | `/admin/face-enrollment-consents/:id/revoke` | Отзыв согласия (`revoked_at`, `revoke_reason`). Каскадно деактивирует связанный `face_profiles.is_active=false`. |
| POST | `/admin/face-profiles/enroll` | Enrollment: `subject_type`, `subject_id`, `video_key` (presigned S3, purpose=`face_enrollment_video`), `consent_id` (обязательно, должен быть активный `face_enrollment_consents`). Enqueue `face:enrollment` → face-service извлекает 5–10 кадров → генерит N embeddings → `face_profiles` + `face_embeddings` + линкует `face_enrollment_consents.face_profile_id`. |
| POST | `/admin/face-profiles/:id/re-enroll` | Переснять видео: новый `video_key` → enqueue `face:enrollment` с флагом replace → старые `face_embeddings` деактивируются, профиль сохраняется. |
| DELETE | `/admin/face-profiles/:id` | Удалить профиль (`DELETE /profiles/{external_id}` в face-service + row + embeddings). Требует активного consent или явного revoke. |
| POST | `/admin/face-profiles/:id/deactivate` | `is_active=false` без удаления (временная приостановка). |
| GET | `/admin/face-recognition-events` | Лог событий распознавания (фильтр: `camera_device_id`, `status`, дата). Видит `rejected_spoof`, `rejected_low_confidence` для анализа. |

### 2.21 Attendance (admin view / corrections)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/attendance-events` | Лог check-in/out (фильтр: `child_id`, `method`, диапазон дат). |
| PATCH | `/admin/attendance-events/:id` | Корректировка: `recorded_at`, `notes`, `pickup_user_id`. |
| GET | `/admin/daily-status` | Сводка `child_daily_status` на дату по садику. |
| GET | `/admin/daily-status/summary` | Агрегированная сводка отсутствий (для заявок vacation/day_off). |

### 2.22 Analytics / Dashboard

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/dashboard/summary` | Агрегат: `{active_children, enrollments_in_processing, invoices_overdue_count, invoices_overdue_amount, mtd_revenue, ytd_revenue, active_staff, active_groups}`. |
| GET | `/admin/dashboard/attendance-today` | `{in_kindergarten, checked_out, absent, on_vacation, sick}` — считается по `attendance_events` за текущий день + `child_daily_status`. Параметр `group_id` — опциональный фильтр. |
| GET | `/admin/dashboard/payments-overview` | Параметры: `from`, `to` (период). Возвращает `{paid: {count, amount}, pending: {count, amount}, overdue: {count, amount}, refunded: {count, amount}}` + breakdown по `provider`. |

---

## 3. Staff API (Staff App — mentor / specialist / reception)

**Назначение:** мобильное приложение для сотрудников садика. При входе с несколькими ролями — показывается выбор (см. `/auth/role/select`). Рабочее пространство определяется ролью.

### 3.1 Profile & Roles

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/me` | Профиль + активная роль + назначенные группы/специализация. |
| GET | `/staff/me/roles` | Все доступные роли пользователя (если `staff_members` содержит несколько записей для него). |

### 3.2 My Groups & Children (mentor / specialist)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/my-groups` | Группы, привязанные к сотруднику через `group_mentors` (для mentor) или все группы садика (для specialist). |
| GET | `/staff/my-groups/:groupId/children` | Дети активной группы. |
| GET | `/staff/children/:id` | Карточка ребёнка (для своей группы или для specialist). Содержит: профиль, allergy/medical_notes, guardians (имена/телефоны), текущая группа, timeline сегодня, последние диагностики. |

### 3.3 Attendance (Check-in / Check-out manual)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/attendance/check-in` | Ручной check-in: `child_id`, опц. `recorded_at`, `notes`. `method='manual'`. |
| POST | `/staff/attendance/check-out` | Ручной check-out: `child_id`, `pickup_user_id` (guardian/trusted), `pickup_request_id` (если был OTP flow), `notes`. |
| PATCH | `/staff/attendance/:eventId` | Корректировка ранее сделанной записи (в окне той же смены). |
| GET | `/staff/attendance/today` | События сегодня по моим группам. |

### 3.4 Face ID (staff-facing)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/face-id/events` | Callback от камеры-экрана (shyraq-face-service): `camera_device_id`, `external_id` (или null), `confidence`, `spoof_score`, `photo_url`. Дедуп Redis `face:seen:*`. Создаёт `face_recognition_events` + (при match) `attendance_events`, `timeline_entries`, push/WS. Rate-limit 300/мин per camera_device_id. |
| GET | `/staff/face-id/events/recent` | Последние события (для Reception-мониторинга). |

### 3.5 Identity QR Scan

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/qr/scan` | Сканирование QR пользователя: проверяет Redis `qr:token:{token}` → возвращает `user + allowed_actions + linked_children[]` (если родитель). Rate-limit 60/мин per staff-device. Логирует `user_qr_tokens.last_scanned_at`. |

### 3.6 Pickup OTP (Trusted Person)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/pickup-requests` | Активные `pickup_requests` по группе (status `otp_sent`). |
| GET | `/staff/pickup-requests/:id` | Детали + `trusted_person_name/phone`, ребёнок. |
| POST | `/staff/pickup-requests/:id/send-otp` | Генерирует 6-digit код, пишет Redis `otp:pickup:{pickup_request_id}` Hash `{code, attempts}` TTL 1800с, отправляет SMS на `trusted_person_phone`. Rate-limit через `rate:otp:{phone}`. |
| POST | `/staff/pickup-requests/:id/verify-otp` | Сотрудник вводит код с устройства trusted-person'а. Читает `otp:pickup:{id}`; при совпадении — DEL, `pickup_requests.status='validated'`, `validated_by=staff_member_id`, `validated_at=NOW()`. Создаёт `attendance_events (method='otp_pickup')`, закрывает связанный `parent_requests` (если есть), если `trusted_people.is_one_time=true` — помечает `revoked_at=NOW()`, `used_at=NOW()`. При 3 неверных — `otp:locked:{phone}` TTL 900с, `status='expired'`. |
| POST | `/staff/pickup-requests/:id/cancel` | Отказ выдачи: `status='cancelled'`, DEL Redis ключ. Push requester'у (`pickup.cancelled`, не в каталоге MVP — можно отложить). |

### 3.7 Timeline & Intraday Status

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/timeline-entries` | Создать запись: `child_id`, `entry_type` (activity/meal/nap/note/photo/mood/medication), `title`, `body`, `media_urls[]`, `metadata`, `entry_time`. |
| PATCH | `/staff/timeline-entries/:id` | Редактировать (только автор или admin). |
| DELETE | `/staff/timeline-entries/:id` | Удалить. |
| GET | `/staff/timeline/child/:id` | Timeline ребёнка (пагинация). |
| POST | `/staff/daily-status` | Установить `child_daily_status` на дату: `child_id`, `date`, `status` (present/absent/sick/late/early_pickup/on_vacation), `note`. |

### 3.8 Activity Events (Schedule progression)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/activity-events/today` | Сегодняшние события моей группы. |
| GET | `/staff/activity-events/suggested-next` | Предлагаемое "Следующее событие" из шаблона расписания. |
| POST | `/staff/activity-events` | Создать событие: `group_id`, `activity_name`, `location_id`, `starts_at`, `ends_at`, `notes`. При создании — обновляется `groups.current_location_id` → WS broadcast `group:{id}:location_changed` (триггер перезапроса CCTV у родителей). |
| POST | `/staff/activity-events/:id/start` | `status='in_progress'`. Обновляет текущую локацию группы. |
| POST | `/staff/activity-events/:id/complete` | `status='completed'`. |
| POST | `/staff/activity-events/:id/cancel` | `status='cancelled'`. |
| GET | `/staff/schedule/week` | Расписание недели моей группы. |

### 3.9 Parent Requests (staff review)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/parent-requests` | Заявки на моих детей/мою группу (фильтр: `status`, `request_type`). Mentor видит day_off/vacation/late_pickup/trusted_person для своей группы; Specialist — `open_request` с `recipient_staff_id=me` или `recipient_type='specialist'`. |
| GET | `/staff/parent-requests/:id` | Детали + messages. |
| POST | `/staff/parent-requests/:id/accept` | `status='accepted'` + `review_note`. |
| POST | `/staff/parent-requests/:id/reject` | `status='rejected'` + note. |
| POST | `/staff/parent-requests/:id/messages` | Ответить в треде. |

### 3.10 Diagnostics (Specialist)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/diagnostic-templates` | Шаблоны моей специализации (фильтр: `specialist_type=my_type`, `is_active=true`). |
| GET | `/staff/diagnostic-templates/:id` | Схема для заполнения. |
| GET | `/staff/diagnostic-entries` | Мои заполненные диагностики (фильтр: `child_id`). |
| POST | `/staff/diagnostic-entries` | Создать: `child_id`, `template_id`, `assessment_date`, `data` (соответствие `schema`), `summary`, `recommendations`, `attachments[]`. |
| GET | `/staff/diagnostic-entries/:id` | Детали. |
| PATCH | `/staff/diagnostic-entries/:id` | Обновить (только автор-specialist). |
| GET | `/staff/my-todos` | Задачи specialist'а: дети, которым нужна новая диагностика. |

### 3.11 Progress Notes (Mentor)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/progress-notes` | Мои заметки (фильтр: `child_id`). |
| POST | `/staff/progress-notes` | Создать: `child_id`, `body`, `media_urls[]`, `noted_at`. |
| PATCH | `/staff/progress-notes/:id` | Обновить. |
| DELETE | `/staff/progress-notes/:id` | Удалить. |

### 3.12 Group Stories (Mentor)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/stories` | Stories моей группы (активные, `expires_at > NOW()`). |
| POST | `/staff/stories` | Опубликовать: `group_id`, `media_url`, `media_type` (image/video), `caption`. Авто `expires_at = created_at + 24h`. |
| DELETE | `/staff/stories/:id` | Удалить досрочно. |

### 3.13 Content (read-only)

**Auth:** `mentor`, `specialist`, or `reception` role.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/schedule/week` | Расписание моей группы на неделю. Query: `week_start_date?` (default: текущая неделя). Response: `[{day_of_week, events: [{id, activity_name, starts_at, ends_at, status, location_id?}]}]`. |
| GET | `/staff/meal-plans` | Меню на период. Query: `date_from`, `date_to`, `group_id?`. Response: `[{date, group_id?, items: [{meal_type, dish_name, allergens?, calories?}]}]`. |
| GET | `/staff/content/news` | Новости садика. |

### 3.14 Enrollments (Admin also acts here; reception)

Reception может работать с заявками — см. Admin API `/admin/enrollments`. Если требуется ограниченная версия — используется общий скоуп через `RolesGuard`.

---

## 4. Parent API (Parent App — родитель/няня)

**Назначение:** мобильное приложение для родителей. JWT содержит `user_id` **без** `kindergarten_id` — tenant резолвится из `children.kindergarten_id` для каждого запроса вида `/parent/children/:id/*`. Для каждого запроса по ребёнку `ChildAccessGuard`:
1. Находит `child_guardians` по `(child_id, user_id)`.
2. Проверяет `status='approved'` AND `revoked_at IS NULL`.
3. Применяет матрицу прав в зависимости от `guardian_role` (см. §4.13).

**Child-profile switching.** У одного родителя может быть несколько детей, возможно в разных садиках и с разными ролями (например, primary у одного, nanny у другого). Переключение контекста происходит на клиенте — выбором активного ребёнка из `GET /parent/children`. Отдельного endpoint'а `switch` нет, права пересчитываются `ChildAccessGuard`'ом на каждом запросе.

### 4.1 Onboarding & Children linking

**B4 закрывает только approval-flow (§4.2)** — primary одобряет добавленных admin'ом guardian'ов. Linking ребёнка по ИИН родителем — B6.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children` | Привязанные дети (approved). |
| POST | `/parent/children/link` | Привязка ребёнка по ИИН: ищет `children` в tenant'ах → если найдено → `child_guardians (role='nanny'|'secondary', status='pending_approval')`. Если родитель — Primary Guardian из enrollment (по телефону) → авто-approve. |
| POST | `/parent/children/:id/unlink` | Отвязать (soft-revoke — `revoked_at`). |
| GET | `/parent/children/:id` | Полная карточка: mentor, группа, timeline, события дня, оплата, диагностики, прогресс. |

### 4.2 Approvals & Permissions (Primary Guardian)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/approvals/pending` | Запросы на привязку к моим детям (я — primary). |
| POST | `/parent/approvals/:guardianId/approve` | Подтвердить привязку: `status='approved'`, опц. `has_approval_rights=true` (не более 2 на ребёнка — enforced индексом). На INSERT: `permissions` seed'ится дефолтами из `role` (см. §4.13). |
| POST | `/parent/approvals/:guardianId/reject` | Отклонить: `status='rejected'`. |
| POST | `/parent/approvals/:guardianId/revoke` | Отозвать ранее одобренного (`revoked_at`, `revoked_by`). |
| PATCH | `/parent/approvals/:guardianId/rights` | Изменить `has_approval_rights` (не более 2 на ребёнка). Требует роли primary. `can_pickup` и остальные toggleable permissions управляются через endpoint ниже. |

**Управление правами secondary/nanny (per-guardian toggle menu).** Primary открывает экран "Права" для выбранного guardian'а, видит текущее состояние всех toggle'ов (по defaults из §4.13 + override'ы из `child_guardians.permissions`), меняет любое число переключателей, жмёт Save → вводит OTP → бэкенд сохраняет патч атомарно.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/guardians/:guardianId/permissions` | Возвращает эффективные права: `{role, effective: {view_timeline, view_payments, pay_invoices, view_diagnostics, view_content, view_cctv, receive_push_non_pickup, create_requests, can_pickup}, overrides: <ключи permissions JSONB, явно переопределённые относительно defaults>, locked: [prepayment, trusted_people_manage, approvals]}`. `can_pickup` и `has_approval_rights` (alias `approvals`) — отдельные колонки таблицы, мержатся в `effective` для UI. Доступ: только primary того же ребёнка. |
| POST | `/parent/children/:id/guardians/:guardianId/permissions/otp-request` | Primary инициирует сохранение. Body: `{permissions: {view_timeline?, view_payments?, pay_invoices?, view_diagnostics?, view_cctv?, receive_push_non_pickup?, create_requests?, can_pickup?}}` — только те ключи, которые меняются. Сервер: валидирует (primary не может менять свои права, не может менять для другого primary, locked-ключи запрещены), считает `payload_hash=SHA256(stable_json(permissions))`, rate-limit `rate:otp:{phone}`, пишет Redis `otp:guardian-permissions:{primary_user_id}:{guardianId}` Hash `{code, attempts, payload_hash}` TTL 300с, отправляет SMS. Возвращает `{request_id, expires_in: 300}`. |
| PATCH | `/parent/children/:id/guardians/:guardianId/permissions` | Применение патча. Body: `{permissions: {...тот же объект, что был в otp-request...}, otp_code}`. Сервер: читает Redis ключ, проверяет `code` И `payload_hash == SHA256(stable_json(body.permissions))`; при совпадении — `UPDATE child_guardians SET permissions = permissions \|\| $patch, permissions_updated_by=me, permissions_updated_at=NOW()`, DEL Redis, WS-broadcast `user:{guardianId_user}` событие `guardian.permissions_updated` (payload: новые effective permissions). При несовпадении `payload_hash` → 409 (клиент попросил OTP под один набор, пытается сохранить другой). При 3 неверных `code` → `otp:locked:{phone}` TTL 900с. |
| POST | `/parent/children/:id/guardians/:guardianId/permissions/reset` | Сбросить все `permissions` overrides → эффективные права возвращаются к defaults из role. Тоже через OTP (flow идентичен выше, тот же ключ). |

**Инварианты:**
- Primary не может редактировать права другого primary. Для смены primary — отдельный flow через `has_approval_rights` (§4.2 первая таблица).
- Toggleable-ключ, которого нет в defaults роли, можно поднять до `true` (например, дать nanny `view_cctv`). Снизить — тоже можно.
- `has_approval_rights`, право на prepayment и утверждение других guardian'ов — НЕ toggleable (locked).

### 4.3 Timeline & Attendance (read)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/timeline` | Timeline ребёнка (пагинация по дате). |
| GET | `/parent/children/:id/attendance` | История check-in/out. |
| GET | `/parent/children/:id/daily-status` | Текущий статус (`present`/`absent`/`sick`/...) + события дня. |

### 4.4 Invoices & Payments

**Три типа оплаты в MVP:**
1. **Monthly** — оплата текущего месяца (полная или частичная).
2. **Prepayment** — досрочная оплата на 3/6/12 месяцев (опционально 24 — если `discount_rules.prepay_24m_pct` задан админом). Создаётся отдельный invoice с `invoice_type='prepayment_{3|6|12|24}m'` и скидкой.
3. **Partial** — оплата меньшей суммы за текущий месяц. Использует тот же endpoint `/pay` с `amount < invoice.amount_after_discount`; статус инвойса становится `partial`, остаток остаётся.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/invoices` | Инвойсы ребёнка (фильтр: `status`, `invoice_type`, диапазон `due_date`). `ChildAccessGuard`: доступен для `primary`/`secondary`; 403 для `nanny`. |
| GET | `/parent/invoices/:id` | Детали + `invoice_line_items` + применённые `custom_discount_applications`. |
| POST | `/parent/invoices/:id/pay` | Инициировать оплату текущего invoice. Body: `{provider: 'halyk_epay'\|'kaspi_pay'\|'tiptoppay'\|'freedom_pay', payment_mode: 'full'\|'partial', amount?: decimal, idempotency_key: string}`. При `partial` `amount` обязателен и должен быть < `invoice.amount_after_discount - sum(payments_completed)`. Создаёт `payments (status='initiated', idempotency_key)`, возвращает `{payment_id, redirect_url?, deeplink?}`. При `partial` после `webhook → completed` статус инвойса становится `partial`; при полном покрытии — `paid`. Доступен для `primary`/`secondary`. |
| POST | `/parent/invoices/:id/pay/prepayment` | Досрочная оплата. Body: `{months: 3\|6\|12\|24, provider, idempotency_key}`. Сервер: находит активный `tariff_assignments` ребёнка, берёт `discount_rules.prepay_{N}m_pct` (если `prepay_24m_pct` отсутствует — 400 `{error: 'prepayment_horizon_not_configured'}`), создаёт новый invoice `invoice_type='prepayment_{N}m'` с правильным `amount_after_discount`, инициирует платёж. Ответ: `{invoice_id, payment_id, redirect_url, preview: {base_amount, discount_pct, final_amount, covers_period: {from, to}}}`. Доступен только `primary`. |
| GET | `/parent/children/:id/payment-calendar` | Календарь платежей в Kaspi-стиле. Параметры: `months_ahead=12` (1..24). Возвращает массив элементов на каждый месяц в окне: `{month: 'YYYY-MM', status: 'paid'\|'pending'\|'overdue'\|'partial'\|'projected', amount, invoice_id?, due_date, is_projection: bool, holidays_affected: int, prepayment_coverage?: {invoice_id, covers_through_month}}`. Для месяцев, где invoice уже создан (cron `billing:invoice-generate` или prepayment) — реальные данные. Для будущих месяцев — projection из активного `tariff_assignments` + `kindergarten_holidays` (pro-rata). Если месяц покрыт prepayment-invoice — `status='paid'`, `prepayment_coverage` указывает источник. Доступен для `primary`/`secondary`, **403 для `nanny`**. |
| GET | `/parent/payments` | Мои платежи (`payer_user_id=me`). Фильтр: `status`, `provider`, `child_id`, диапазон дат. |
| GET | `/parent/payments/:id` | Детали. |
| GET | `/parent/payments/:id/receipt` | Фискальный чек — возвращает `{qr_url, fiscal_sign, receipt_number, issued_at}` из `fiscal_receipts`. 404 если `status != 'issued'`. |

### 4.5 Payment Webhooks (провайдеры — не parent-facing, но логически здесь)

Общий контракт всех webhook'ов: верификация HMAC-SHA256 по секрету провайдера → `SET NX payment:idempotency:{provider_txn_id}` TTL 86400с (если ключ уже есть — 200 no-op) → enqueue `payment:webhook` в BullMQ → ответ провайдеру в <2с. Worker в транзакции: upsert `payments`, апдейт `invoices.status`, апдейт `payment_accounts.balance`, enqueue `fiscal:issue-receipt`, push `payment.receipt_issued`.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/payments/webhook/halyk` | Webhook Halyk ePay. **Production — обязательный провайдер.** |
| POST | `/payments/webhook/kaspi` | Webhook Kaspi Pay API. **Под вопросом** — оставляем endpoint, финализация интеграции после подтверждения доступа к Kaspi Pay API (возможно уход в v2). |
| POST | `/payments/webhook/tiptoppay` | Webhook TipTopPay. **Один из пары TipTopPay/FreedomPay** — финальный выбор до начала интеграции. |
| POST | `/payments/webhook/freedom-pay` | Webhook Freedom Pay. **Один из пары TipTopPay/FreedomPay** — финальный выбор до начала интеграции. |

### 4.6 Trusted People

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/trusted-people` | Whitelist доверенных. |
| POST | `/parent/children/:id/trusted-people` | Добавить: `full_name`, `phone`, `iin`, `relation`, `photo_url`, `is_one_time`. |
| PATCH | `/parent/trusted-people/:id` | Обновить. |
| POST | `/parent/trusted-people/:id/revoke` | Отозвать (`revoked_at`). |

### 4.7 Parent Requests

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/requests` | Мои заявки (фильтр: `status`, `request_type`). |
| GET | `/parent/requests/:id` | Детали + messages. |
| POST | `/parent/requests/trusted-person` | Заявка на доверенное лицо: `child_id`, `trusted_person_id` (ссылка на whitelist) или inline `{full_name, phone, iin}`. Требует OTP-подтверждение родителя перед отправкой — сначала вызывается `POST /parent/requests/otp-request` (см. ниже), затем этот endpoint с полем `otp_code`. Создаёт также `pickup_requests` при необходимости. Доступен только `primary`. |
| POST | `/parent/requests/otp-request` | Запрос OTP для подтверждения чувствительной заявки. Body: `{request_type: 'trusted_person', child_id}`. Сервер: rate-limit `rate:otp:{phone}`, генерит код, пишет Redis `otp:request-confirm:{user_id}:{request_type}` Hash `{code, attempts}` TTL 300с, отправляет SMS на телефон `users.phone`. |
| POST | `/parent/requests/day-off` | Заявка на выходные: `child_id`, `date_from`, `date_to`, `details: {comment}`. |
| POST | `/parent/requests/vacation` | Заявка на отпуск: `child_id`, `date_from`, `date_to`, `details: {comment}`. |
| POST | `/parent/requests/late-pickup` | Заявка на поздний забор: `child_id`, `date_from`, `details: {expected_time}`. Создаёт `invoice` с `invoice_type='late_pickup_fee'` → после оплаты `status='pending'→'active'`. |
| POST | `/parent/requests/open` | Открытая заявка: `child_id`, `recipient_type` (admin/mentor/specialist), `recipient_staff_id`, `details: {subject, message}`, `attachments[]`. |
| POST | `/parent/requests/:id/cancel` | `status='cancelled'`. |
| POST | `/parent/requests/:id/messages` | Ответить в треде. |
| POST | `/parent/requests/confirm-otp` | Подтверждение OTP для чувствительных заявок. Body: `{request_type, otp_code}`. Читает `otp:request-confirm:{user_id}:{request_type}`; при совпадении — DEL ключа и возвращает `{confirm_token}` (подпись HMAC, TTL 60с), который клиент передаёт в `POST /parent/requests/trusted-person` в поле `confirm_token`. При 3 неверных попытках — `otp:locked:{phone}` TTL 900с. |

### 4.8 CCTV

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/cctv/access` | Определяет камеры: `child.current_group_id → groups.current_location_id → cameras WHERE location_id=? AND is_active`. Генерит Redis `cctv:token:{user_id}:{camera_id}` TTL 3600с. Возвращает `[{camera_id, name, stream_url: "https://stream.shyraq.kz/live/{cam}/index.m3u8?token=xxx"}]`. Клиенту рекомендуется подписаться на WS-комнату `group:{group_id}:location_changed` и при получении события `location_changed` перезапросить этот endpoint. Доступен для `primary`/`secondary`; **403 для `nanny`**. |
| GET | `/cctv/validate` | Внутренний endpoint для Nginx `auth_request`. Читает `cctv:token:{user_id}:{camera_id}`, сравнивает с `?token=`. Возвращает 200/403. Не вызывается клиентами. |

### 4.9 Content Feed

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/feed` | Лента: news, qundylyq, birthdays, targeted posts (all / group / child). Локализовано по `users.locale`. |
| GET | `/parent/content/news` | Только новости. |
| GET | `/parent/content/qundylyq/current` | Текущий Qundylyq (тема месяца). |
| GET | `/parent/children/:id/menu` | Меню на период. Query: `date_from`, `date_to` (ISO date, обязательны). Возвращает `meal_plans` группы ребёнка (приоритет) или общего садика за период с вложенными `meal_items`. Response: `[{date, items: [{meal_type, dish_name: {ru,kz}, description?, allergens?, calories?, photo_url?}]}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| GET | `/parent/children/:id/schedule` | Расписание группы ребёнка. Query: `date_from`, `date_to` (ISO date, обязательны). Возвращает `activity_events` группы за период. Response: `[{id, activity_name, starts_at, ends_at, status, location_id?, notes?}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| GET | `/parent/children/:id/stories` | Активные stories группы (`expires_at > NOW()`). |
| POST | `/parent/stories/:id/view` | Инкремент `group_stories.views`. |

### 4.10 Diagnostics & Progress (read)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/diagnostics` | Диагностики ребёнка (все специалисты, пагинация по дате). |
| GET | `/parent/children/:id/diagnostics/:entryId` | Детали: `data`, `summary`, `recommendations`, `attachments`. |
| GET | `/parent/children/:id/progress-notes` | Заметки прогресса от mentor. |

### 4.11 Face ID (parent-side)

**В MVP у Parent App нет endpoint'ов для enrollment.** Enrollment ребёнка / родителя / сотрудника происходит только в садике через Admin API (`POST /admin/face-profiles/enroll`, см. §2.20), после офлайн-фиксации consent (`POST /admin/face-enrollment-consents`). Это требование закона РК о биометрических данных.

Parent App видит факт наличия enroll'а через `GET /parent/children/:id` (поле `face_enrollment: {enrolled: bool, enrolled_at, consent_revokable_via: 'admin'}`), но не может сам его создать или отозвать — отзыв только через `POST /admin/face-enrollment-consents/:id/revoke` по запросу родителя.

### 4.12 Kindergarten Info

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/kindergarten` | Публичная инфа о садике ребёнка (name, address, phone, локали). |

### 4.13 Guardian Permissions Matrix

Реализуется в `ChildAccessGuard`. Эффективное право на endpoint считается как:

```
effective[perm] = child_guardians.permissions[perm] ?? DEFAULT_FOR_ROLE[role][perm]
```

Это значит: **defaults ниже — стартовые**, primary может override'ить их через §4.2 "Управление правами" (кроме locked-колонки).

| Permission key (defaults) | primary | secondary | nanny | Locked? | Покрывает endpoints |
|---|---|---|---|---|---|
| `view_timeline` | ✅ | ✅ | ✅ | — | GET children/:id, timeline, attendance, daily-status, menu, schedule, stories |
| `view_payments` | ✅ | ✅ | ❌ | — | GET invoices, payments, receipt, payment-calendar |
| `pay_invoices` | ✅ | ✅ | ❌ | — | POST invoices/:id/pay (monthly/partial) |
| `view_diagnostics` | ✅ | ✅ | ❌ | — | GET diagnostics, progress-notes |
| `view_content` | ✅ | ✅ | ❌ | — | GET feed, content/* |
| `view_cctv` | ✅ | ✅ | ❌ | — | GET /parent/cctv/access |
| `receive_push_non_pickup` | ✅ | ✅ | ❌ | — | Все push/WS кроме `attendance.*`, `pickup.*` |
| `create_requests` | ✅ | ✅ | ❌ | — | POST requests/day-off, vacation, late-pickup, open |
| `can_pickup` (колонка) | ✅ | ✅ | ✅ | — | Используется при check-out |
| `prepayment` | ✅ | ❌ | ❌ | **locked** | POST invoices/:id/pay/prepayment |
| `trusted_people_manage` | ✅ | ❌ | ❌ | **locked** | Trusted people CRUD + requests/trusted-person |
| `approvals` (`has_approval_rights`) | ✅ (≤2) | ❌ | ❌ | **locked** | Approve/reject/revoke/rights других guardian |

**Минимум для nanny:** даже с всеми override'ами nanny не становится primary. Locked-права передать нельзя.

**`attendance.*` и `pickup.*` push/WS** — всегда доставляются всем одобренным guardian'ам, независимо от `receive_push_non_pickup`.

**Изменение прав → WS.** После `PATCH /parent/children/:id/guardians/:guardianId/permissions` бэкенд отправляет в `user:{guardianId_user}` событие `guardian.permissions_updated` — клиенту надо инвалидировать локальные кэши доступа и возможно закрыть экраны, на которые больше нет прав.

---

## 5. Out of MVP — v2 blockers

Всё, что ранее было в "выведено логически", зафиксировано в §0–§4. Ниже — осознанно исключённое из MVP, что надо закрыть до коммерческого запуска.

### 5.1 Блокеры перед платным production

| Тема | Что нужно | Причина |
|---|---|---|
| **Consents (общие)** | Таблица `consents` (обработка ПДн, фото, CCTV) + `POST /parent/consents/grant\|revoke`, `GET /admin/consents/export`. | Закон РК о персональных данных. Для Face ID consent уже заложен через `face_enrollment_consents` (§2.20) — это MVP. Остальные — v2. |
| **Incidents** | Таблица `incident_reports` + `/admin/incidents`, `/staff/incidents`, `/parent/children/:id/incidents`, подпись родителя в акте. | Регуляторное требование + операционный риск. |
| **Child documents** | `child_documents` (свидетельство о рождении, мед.справка, прививки) + CRUD endpoints. | Обычный процесс enrollment в офлайн-садиках. |
| **Child health log** | `child_health_log` (температура, лекарства) + `/staff/children/:id/health-log`. | Интерес родителей и требование СЭС. |
| **Audit log** | `audit_log` + `/admin/audit-log` (фильтры по entity, user). Критичные события: children, payments, guardians, face_profiles, consents. | Безопасность, compliance. |
| **Data export / delete (ZRK 94-V)** | `data_export_requests` + `/parent/me/data/export`, `/parent/me/data/delete`. | Право субъекта ПДн на доступ и удаление. |
| **Чат parent ↔ mentor** | Полноценный `/chats`, `/chats/:id/messages`. | Сейчас коммуникация возможна только через треды `parent_request_messages` внутри заявок. |

### 5.2 Сознательно отложенные фичи, которые могут понадобиться

- **Face ID enrollment из Parent App** — сейчас только admin-side в садике. При расширении тарифов может понадобиться self-serve enrollment с video review модерацией.
- **QR ручной refresh в UI** — сейчас только автоматический серверный refresh (§0.2). Кнопка "Обновить" у пользователя — если придёт запрос.
- **Multi-role staff switching** — сотрудники пока с одной активной ролью; `/auth/role/select` оставлен минимально. Полный switching в v2.
- **Admin: revoke all QR tokens of user** — `POST /admin/qr/revoke-all/:userId` — security-фича, отложена.
- **Custom discount dry-run preview** — `POST /admin/custom-discounts/:id/preview` ("42 ребёнка попадут под скидку") — отложен, dry-run считается на клиенте через `/admin/custom-discounts/:id/applications` после активации.
- **CCTV access log** — отдельная таблица `cctv_access_log` для compliance.
- **CCTV concurrent viewers limit** — сейчас ограничение только на уровне MediaMTX/сети; без API-контроля.
- **SMS delivery monitoring** — admin-endpoint для анализа неудачных SMS (аналог `/admin/fiscal-receipts/queue`).
- **Trusted-person pickup через QR вместо SMS** — расширение `user_qr_tokens.purpose` (в BP описано как архитектурный задел).
- **Notification preferences для stuff** — сейчас preferences только для родителей; сотрудники пока без mute.

### 5.3 Открытые продуктовые вопросы (нужно решение до кодинга)

- **Автоматическое `tariff_assignment` при `enrollment → card_created`** — создавать ли default (первый активный `monthly_base` для возрастной группы), или всегда требовать явного назначения через `/admin/tariff-assignments`? **Рекомендация:** автосоздание из активного базового тарифа группы; если его нет — возвращать 409 при попытке transition.
- **SMS provider** — "Kazakh SMS gateway / Twilio" — конкретный поставщик для MVP не выбран. Влияет на `OtpModule` абстракцию.
- **TipTopPay vs FreedomPay** — финальный выбор до начала интеграции, один из двух endpoint'ов будет "мёртвым".
- **Kaspi Pay API** — подтвердить доступ / контракт. Если не выдают — провайдер уходит в v2.

**Что полностью закрыто в планах:** enrollment, children lifecycle, groups, staff provisioning с mentor-инвариантами, attendance (Face ID + fallback + OTP pickup), schedule + auto-copy, meal plans + auto-copy, content (news/qundylyq/birthday/stories), tariff engine + pro-rata + holidays, invoices/payments + 4 провайдера, fiscal receipts (ОФД), custom discounts engine, Identity QR, parent requests (5 типов), trusted people (one-time + whitelist), diagnostics + progress.
