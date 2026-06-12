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
| GET | `/health/ready` | Readiness probe. Параллельный `PING` к PostgreSQL (`SELECT 1`) и Redis с timeout 1s каждый. `200 OK` если оба up: `{ status: 'ok', checks: { db: 'up', redis: 'up', kaspi: 'up'\|'down'\|'unknown' } }`. `503 Service Unavailable` если хотя бы один из db/redis down: `{ status: 'degraded', checks: { db, redis, kaspi } }`. `checks.kaspi` (B24 K9) — INFORMATIONAL версия-гейт Kaspi, НЕ влияет на `status`/readiness (см. §1.8); при наличии снимка добавляется `kaspi_detail: { build, checked_at }`. |

### 0.1 Auth (OTP + JWT)

Три клиентских приложения (**Parent / Staff / Admin**) ходят через единый OTP-флоу, но с разным **audience** — клиент явным полем `app` сообщает, в какую аппку логинится. Access-токен — JWT (HS256, TTL 15m) с claim `aud` (`parent`/`staff`/`admin`). Refresh-токен — **opaque random hex (32 bytes)**, в БД хранится только `token_hash = SHA256(raw)` в `refresh_tokens` (+ колонка `audience`); TTL `REFRESH_TOKEN_TTL_DAYS` (default 30). Ротация — `UPDATE revoked_at=NOW()` + insert new; старый access-`jti` — в `token:blocklist:{jti}` до исходного `exp`. Формат `jti` — uuid v4.

**Audience-фильтр (закрывает дыру cross-app эскалации).** Один телефон может иметь роли в разных аппках (например `admin` в одном садике и `parent` в другом). До app-aware версии `/auth/otp/verify` игнорировал источник входа и мог выдать admin-scope токен в Parent App. Теперь роли фильтруются по `app` **до** ролевого резолва, и `audience` зашивается в access (`aud`) + `refresh_tokens.audience`, чтобы `/auth/refresh` не «перепрыгнул» в другую аппку:

| `app` | Допустимые роли |
|---|---|
| `parent` | `parent` (открытая регистрация — см. ниже) |
| `staff`  | `mentor`, `specialist`, `reception` |
| `admin`  | `admin` |

`admin` **строго не заходит** в Staff App, и наоборот. У `staff_members` действует `UNIQUE (kindergarten_id, user_id) WHERE is_active=true` → у юзера максимум одна активная роль в одном садике, поэтому выбор при multi-kg — это выбор **садика** (роль derive из записи), отдельной «под-роли» нет.

> **Статус:** app-aware контракт раскатывается поэтапно (docs-first). Порядок: (1) этот doc, (2) app-фильтр + existence-check в `request`/`verify`, (3) `aud`-claim + `refresh_tokens.audience` (миграция), (4) parent-экстра поля в verify-ответе, (5) `GET /parent/children/pending-requests` (§4).

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/otp/request` | Отправить OTP. Body `{phone, app}` (`app` ∈ `parent`/`staff`/`admin`). Валидация phone `/^\+7\d{10}$/`. **`app=staff`/`admin`: closed-app** — ищем `users` по phone + активную `staff_members` с допустимой ролью (см. таблицу audience); нет → **404 `not_invited`, OTP НЕ отправляем** (staff/admin заводятся только инвайтом из админки/суперадмина). **`app=parent`: open registration** — OTP шлём всегда. Rate-limit 5/hour per phone (Redis `rate:otp:{phone}` TTL 3600с). Lockout-check: `otp:locked:{phone}` → 429 `otp_locked`. Генерит 6-digit код (или `OTP_TEST_CODE` для phone'ов из `OTP_TEST_PHONES`), пишет `otp:login:{phone}` Hash `{code, attempts:0}` TTL 300с. SMS через `SmsProvider` (mock-adapter логирует в stdout; для whitelisted phone'ов не шлётся). Response `202 Accepted` — `{sent: true, registered: <bool>, resend_after_sec: 60}` (`registered` = существует ли уже `users`-строка; для staff/admin всегда `true`). |
| POST | `/auth/otp/verify` | Проверить OTP. Body `{phone, code, app, kindergarten_id?}` (`role` НЕ передаётся — derive). Headers: `X-Device-Id` (optional) — персистится на новом `refresh_tokens.device_id` (NULL для legacy). Читает `otp:login:{phone}` (missing → 400 `otp_expired_or_missing`); mismatch → `HINCRBY attempts`; at 3 → `SET otp:locked:{phone} TTL 900s` + `DEL otp:login:{phone}` → 429 `otp_locked`. Success → DEL, lookup/create user by phone. Роли фильтруются по `app`; выдача токенов — по ролевому резолву (см. ниже). `audience` зашивается в `aud` + `refresh_tokens.audience`. |
| POST | `/auth/refresh` | Ротация refresh-токена. Headers: `X-Device-Id` (optional) — перезаписывает `device_id` на свежей строке; legacy-клиенты не передают, и старое значение переносится. Body `{refresh_token}`. Lookup по `SHA256(refresh_token)`; проверка `revoked_at IS NULL AND expires_at > NOW()` (иначе 401 `invalid_refresh`). Роли при ре-резолве фильтруются по сохранённому `refresh_tokens.audience` (сессия не меняет аппку). В одной TypeORM-транзакции: `UPDATE refresh_tokens SET revoked_at=NOW()` + `INSERT` новый (тот же `audience`); после commit — `SET token:blocklist:{old_access_jti}` TTL = remaining access TTL (best-effort). Response — новая пара. Клиент должен передать текущий access-токен в `Authorization: Bearer …` — без него blocklist пропускается (best-effort). |
| POST | `/auth/logout` | Bearer-protected. Revoke current refresh (`UPDATE revoked_at=NOW()` по `token_hash` из body, если передан; иначе ревокация по `user_id`). `SET token:blocklist:{current_access_jti}` TTL = remaining. Response `204 No Content`. Дозволен для JWT с `pending_role_select:true` (whitelist). |
| POST | `/auth/role/select` | Выбор активного **садика** для multi-kg staff/admin (2+ активных `staff_members` в рамках одной аппки). Headers: `X-Device-Id` (optional) — персистится на новой `refresh_tokens.device_id`. Требует JWT с claim `pending_role_select:true` (иначе 403 `role_select_not_required`). Body `{kindergarten_id}` (`role` опционален и не нужен — derive из `staff_members WHERE user_id=? AND kindergarten_id=? AND is_active=true`; нет записи → 403 `role_not_available`). Issue новый access `{sub, role, kindergarten_id, aud, jti}` + opaque refresh (с тем же `audience`); старый временный access `jti` → `token:blocklist:{jti}`. Response = стандартный auth-response. **Родители НЕ используют этот endpoint** — у них одна `parent`-аудитория без выбора. |

**Auth response shape** (возвращает `/auth/otp/verify`, `/auth/refresh`, `/auth/role/select`):

```jsonc
{
  "access_token": "eyJhbGciOi...",        // JWT, HS256, 15m, claim aud=parent|staff|admin
  "refresh_token": "3a7f...b2c1" | null,  // 64 hex chars; null, если pending_role_select=true
  "token_type": "Bearer",
  "expires_in": 900,                       // seconds of access_token TTL
  "pending_role_select": false,            // true у multi-kg staff/admin до /auth/role/select
  "roles": [
    { "role": "admin",  "kindergarten_id": "uuid", "group_id": null }
  ],
  "kindergartens": [
    { "id": "uuid", "name": "Солнышко", "slug": "sunshine" }
  ],
  "user": { "id": "uuid", "phone": "+7...", "full_name": "...", "iin": null,
            "date_of_birth": null, "locale": "ru", "avatar_url": null },

  // --- ТОЛЬКО при app=parent ---
  "is_new_user": true,                     // строка users была создана этим verify
  "profile_complete": false,               // full_name + date_of_birth + iin все заполнены
  "parent_context": {
    "approved_children_count": 0,          // approved guardian-связей
    "pending_requests_count": 1            // мои link-заявки в статусе pending_approval
  }
}
```

- `roles[]` — после audience-фильтра содержит только роли активной аппки.
- `kindergartens[]` — уникальные садики из `roles[]`; для Parent без staff-ролей пустой массив.
- `is_new_user` / `profile_complete` / `parent_context` присутствуют **только** в ответе при `app=parent`; для staff/admin отсутствуют.

**Ролевой резолв в `/auth/otp/verify` (после audience-фильтра):**

1. `app=parent` → **Parent**. JWT `{sub, role:'parent', aud:'parent', jti}` без `kindergarten_id` (implicit-parent даже при 0 детей — токен выдаётся, гейт «нужен ≥1 ребёнок» обрабатывает клиент по `parent_context`). Refresh выдан. **Parent App — open-registration:** авторизация проходит ВСЕГДА (логин или регистрация), даже если у телефона есть staff/admin-роль и/или нет ни одной guardian-связи. Audience-фильтр выкидывает staff/admin-роли, и при пустом результате подставляется неявная `{role:'parent', kg:null}` (понижение привилегий безопасно; защита parent→staff/admin при этом не ослабляется). Так родитель может зайти, добавить ребёнка по ИИН и увидеть pending-approval список.
2. `app=staff`/`admin`, ровно одна активная запись → **Single-role**. JWT `{sub, role, kindergarten_id, aud, jti}`. Refresh выдан с `kindergarten_id` + `audience`.
3. `app=staff`/`admin`, 2+ активных записи в разных садиках, `kindergarten_id` не передан → **Multi-kg select** (D2). JWT `{sub, role:'staff_multi_role', aud, pending_role_select:true, jti}`. **Refresh не выдаётся**. Клиент шлёт `kindergarten_id` в `/auth/role/select`. Если `kindergarten_id` передан сразу в verify и матчит активную запись — пропускаем select, выдаём полную пару.
4. После фильтра ни одной роли под аппку → 403 `no_role_for_app` — **только для `app=staff`/`admin`** (например parent ломится в Staff App, или staff без активных записей). Для `app=parent` этот код не выбрасывается никогда (см. п.1).

**Auto-approve primary guardian:** после успешной OTP-верификации, до ролевого резолва, бэкенд через bypass_rls cross-tenant ищет `child_guardians (user_id=self, role='primary', status='pending_approval')` и переводит каждую в `approved` (`approved_by=user_id`, `has_approval_rights=true`). Покрывает кейс «родитель регистрируется и одновременно был назначен primary при enrollment'е» — primary заводится только из админки и потому не требует внешнего approve.

**Error codes:**

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `otp_expired_or_missing` | `/auth/otp/verify`: ключа `otp:login:{phone}` нет |
| 400 | `invalid_otp` | `/auth/otp/verify`: mismatch (но attempts < 3) |
| 400 | `invalid_phone_format` | DTO validation: phone не E.164 |
| 404 | `not_invited` | `/auth/otp/request` с `app=staff`/`admin`: нет user'а или активной `staff_members` с допустимой ролью. OTP не отправляется. |
| 401 | `invalid_refresh` | `/auth/refresh`: токен отозван, истёк или не найден |
| 401 | `invalid_token` | JwtAuthGuard: JWT битый или expired |
| 401 | `token_revoked` | JwtAuthGuard: `jti` в blocklist |
| 403 | `no_role_for_app` | `/auth/otp/verify` с `app=staff`/`admin`: после audience-фильтра у пользователя нет роли под запрошенную `app`. **Для `app=parent` не выбрасывается** — Parent App open-registration, всегда выдаётся parent-сессия |
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
| GET | `/users/me/qr` | (B10) Возвращает текущий Identity QR. Auth: `JwtAuthGuard` (любая роль кроме `pending_role_select`). Reuse-or-mint: если активный токен есть и до `expires_at` осталось >1 часа → возвращает тот же plaintext (recover из `qr:user:{userId}:identity`); иначе транзакционно ревокирует старый (`user_qr_tokens.revoked_at`), создаёт новый (TTL 24ч), синхронизирует обе Redis-записи (`qr:token:{plaintext} → user_id` + `qr:user:{userId}:identity → plaintext`). Каждое issueOrRefresh начинается с `pg_advisory_xact_lock` keyed on user-id, чтобы конкурентные GET'ы сериализовались. Ответ: `{token: string (32 hex chars), issued_at: ISO8601, expires_at: ISO8601}`. Lazy-issue: токен создаётся только при первом вызове, не на login. |

> Ручного refresh-endpoint'а (`POST /users/me/qr/refresh`) в MVP нет — обновление только серверное, автоматическое.

> **Parent-онбординг** (когда `/auth/otp/verify` вернул `profile_complete:false`) переиспользует эту пару: клиент зовёт `GET /users/me` (показать то, что admin мог автозаполнить при создании опекуна), родитель дозаполняет недостающее и шлёт `PATCH /users/me`. Отдельного «регистрационного» endpoint'а нет. `profile_complete` = `full_name` + `date_of_birth` + `iin` все заполнены.

### 0.3 Push tokens (FCM/APNS)

<!-- Implemented in B9 -->

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/push-tokens` | Зарегистрировать device token. Body: `token` (string), `platform` (`'ios'`/`'android'`/`'web'`), `app_version?` (string), `device_id?` (string). Upsert по глобально-уникальному `(platform, token)` — если токен уже принадлежал другому пользователю, запись переназначается текущему (transfer-on-reuse). Используется Parent App и Staff App. |
| DELETE | `/push-tokens/:id` | Удалить device token (logout из этого устройства). |

### 0.4 Notifications

<!-- Implemented in B9 -->

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/notifications` | История уведомлений текущего юзера. Query params: `unread_only` (boolean), `limit` (int, default 20), `cursor` (timestamptz ISO, cursor-based pagination по `created_at`), `event_key` (optional filter). Локализуется по `users.locale` с fallback на RU. |
| POST | `/notifications/:id/read` | `read_at=NOW()`. WS-broadcast `notification.read` в `user:{id}`. |
| POST | `/notifications/read-all` | Массовый `read_at=NOW()`. |
| GET | `/notifications/preferences` | Возвращает per-event настройки (`event_key`, `push_enabled`, `in_app_enabled`). Отсутствующие записи считаются `true/true`. |
| PATCH | `/notifications/preferences` | Upsert записей в `notification_preferences` по `(user_id, event_key)`. Body: `[{event_key, push_enabled?, in_app_enabled?}, ...]`. |

**Event catalog.** Полный справочник `event_key`, адресатов, каналов и payload схем — см. `architecture.md` §5.14 "Notification event catalog". Каноничный список — `src/modules/notification/event-keys.ts` (`CANONICAL_EVENT_KEYS`). Активные ключи (B22a): `attendance.checkin/checkout`, `daily_status.changed`, `timeline.entry_created`, `guardian.approved/self_revoked/pending_approval/rejected/revoked/permissions_updated`, `child.transferred/archived/reactivated`, `diagnostic.new`, `progress_note.new`, `pickup.otp_sent/validated`, `content.news_published/story_new/qundylyq_new/birthday`, `discount.activated`, `request.accepted/rejected/cancelled/message_sent`, `invoice.created/paid/overdue/cancelled`, `payment.completed/failed/refunded`, `refund.processed`, `enrollment.first_invoice_skipped`, `kaspi.session_expired` (B24/K8 — адресаты: активные админы садика; producer — K8-поллер, когда SignInLite-refresh кассирской сессии Kaspi не удался; payload — pre-resolved `recipientUserIds`), `notification.read`, `qr.revoked`.

> **Deferred / future keys** (отсутствуют в `CANONICAL_EVENT_KEYS` сегодня; вернутся в соответствующих батчах с producer-ом + template-ом): `payment.upcoming` / `payment.overdue` / `payment.receipt_issued` (B14 — реальный payment-provider + dunning), `request.reviewed` / `request.message_replied` (B15 — review queue + threaded reply), `face.enrolled` (B19), `fiscal.retry_failed` (B14 — OFD/fiscal retry escalation). Снято в B22a SP7 (T13 L1 codex), чтобы PATCH `/notifications/preferences` не валидировал ключи без backing producer.

**Nanny policy:** guardian с `role='nanny'` получает только `attendance.*` и `pickup.*` (отбрасывается в `NotificationDispatcher`). Настройки в `/notifications/preferences` для остальных ключей игнорируются.

### 0.5 Storage (S3 presigned)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/storage/presigned-upload` | Получить `{upload_url, key, expires_in: 300}`. Валидация `contentType` по allowlist per `purpose` (avatar, child_photo, story, diagnostic_attachment, face_enrollment_video, chat_media). |
| POST | `/storage/confirm-upload` | Подтвердить загрузку: обновляет ссылку в целевой сущности (например, `children.photo_url`, `content_posts.media_urls[]`). |
| GET | `/storage/download/:key` | Presigned GET URL (TTL 3600с) для приватных файлов. |

### 0.6 WebSocket

<!-- Implemented in B9 -->

Не REST. Подключение — `wss://host/ws`. JWT передаётся в `socket.handshake.auth.token` (socket.io v4 standard; **не** в query-параметре — query попадает в access-логи).

**Auth:** `NotificationGateway.handleConnection` верифицирует токен через `JwtTokenPort` + `TokenBlocklistPort` на каждом handshake. Неверный/отсутствующий/отозванный токен → сервер эмитит `auth_error` событие (`{ message: 'unauthorized' }`) и отключает сокет. Обратите внимание: `connect_error` в socket.io v4 зарезервирован для middleware-уровня и с сервера не эмитируется — клиент должен слушать `auth_error`.

**Long-lived session safety (F15):** handshake-only auth не закрывает (1) logout, (2) истечение access-token TTL, (3) admin revoke. Гейтвей реализует две защиты:
- Per-socket TTL — `setTimeout` на `payload.exp * 1000 - Date.now()` (cap 24h). При срабатывании сервер шлёт `auth_error` (`{ message: 'token_expired' }`) и `disconnect(true)`.
- Blocklist propagation — `RedisTokenBlocklistAdapter.blocklist()` после SET публикует `token:blocklist:events <jti>`. `WsBlocklistListenerService` (per api-process subscriber) находит локальные сокеты с этим jti и шлёт им `auth_error` (`{ message: 'session_revoked' }`) + `disconnect(true)`. Logout / refresh / role/select все триггерят этот путь автоматически — клиенту достаточно подписаться на `auth_error` и обработать `session_revoked` как принудительный выход.

**Handshake response:** после успешной аутентификации сервер эмитит `connected` событие:
```json
{ "user_id": "<uuid>", "rooms": ["user:<uuid>", "child:<uuid>", ...] }
```

**Auto-subscribe (без client-subscribe message):** сразу после handshake `WsAutoSubscribeService` добавляет сокет в комнаты согласно `role` + `kindergarten_id` из JWT:
- `user:{user_id}` — всегда.
- `child:{child_id}` — только при `role = 'parent'` И наличии `kindergarten_id` в JWT. По каждому ребёнку с `approved` guardian-связью в рамках этого kg.
- `group:{group_id}` — только при `role` ∈ staff-ролей (`admin`, `staff`, `mentor`, `manager`, `methodist`, `medic`, `cook`, `driver`, `security`) И наличии `kindergarten_id` в JWT. По каждой группе с активным mentor-assignment в рамках этого kg.
- `super_admin` и `pending_role_select=true` — только `user:{user_id}`. Kg-scoped комнаты не назначаются.

Комнаты определяются строго по JWT в момент handshake — cross-tenant guardian/mentor-связи в других садиках игнорируются. При смене роли или kg пользователь должен переподключиться с новым JWT.

**Broadcast format:** диспетчер вызывает `wsBroadcaster.broadcastToUser(userId, event_key, payload)` — никакого envelope-обёртки нет. Клиент получает событие под именем `event_key` (например, `attendance.checkin`), payload — это rendered-шаблон + денормализованные поля:

```json
// Пример события "attendance.checkin" на клиенте:
// socket.on('attendance.checkin', (payload) => { ... })
{
  "title_i18n": { "ru": "Ребёнок прибыл в сад", "kk": "Бала балабақшаға келді", "en": "Child checked in" },
  "body_i18n":  { "ru": "Регистрация прихода зафиксирована.", "kk": "Келу уақыты тіркелді.", "en": "Check-in recorded." },
  "data":       { "childId": "<uuid>", "eventId": "<uuid>", "recordedAt": "<iso>" }
}

// Пример события "guardian.approved":
// socket.on('guardian.approved', (payload) => { ... })
{
  "title_i18n": { "ru": "Доступ к ребёнку подтверждён", "kk": "Балаға қол жетімділік расталды", "en": "Guardian access approved" },
  "body_i18n":  { "ru": "Вам предоставлен доступ как опекуну.", ... },
  "data":       { "childId": "<uuid>", "guardianUserId": "<uuid>" }
}
```

В B9 диспетчер бродкастит исключительно в `user:{userId}` комнаты. Порты `broadcastToChild` / `broadcastToGroup` зарезервированы для B17 (scoped fanout по ребёнку/группе); клиентские комнаты `child:*` и `group:*` уже заполняются при handshake для forward-compatibility.

Полные payload-схемы и правила подписки — `architecture.md` §6.4 "WebSocket room catalog" + §6.5 "Notification event catalog".

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
| GET | `/saas/kindergartens/:id/admins` | Список администраторов конкретного садика (строго `staff_members.role='admin'`). Опциональный query `is_active?: boolean` — при отсутствии возвращаются ВСЕ admin'ы (активные + деактивированные). Response 200: **plain array** (без offset-пагинации). См. §1.2.1. |
| POST | `/saas/kindergartens/:id/admins` | Добавить ещё одного admin'а в существующий садик. Body `{full_name, phone, locale?}`. Find-or-create `users` по `phone` (имя/locale существующего user'а не перезаписываются) + `staff_members(role=admin, is_active=true)`. Best-effort invite-SMS. Строгий 409-конфликт если для пары `(kg, user)` уже есть staff-строка (любого `is_active`). См. §1.2.1. |
| PATCH | `/saas/kindergartens/:id` | Обновить `settings` (timezone, currency, late_pickup_fee_amount, otp_expiry_seconds, prepay скидки, payment_grace_days, fiscal-конфиг), `plan`, `is_active`. |
| DELETE | `/saas/kindergartens/:id` | Soft-delete (через `is_active=false`), cascade-архивация активных сущностей. |

#### 1.2.1 Kindergarten admins — list / add

**Auth (оба endpoint'а):** `Authorization: Bearer <jwt>` где `role ∈ {super_admin, support}`; `@SuperAdminScope()` (RLS bypass, tenant передаётся явно в `:id`). Отсутствие/невалидный/отозванный токен → **401**. Роль не super_admin/support (например kindergarten-`admin`) → **403**.

##### GET `/saas/kindergartens/:id/admins`

Возвращает всех staff-членов садика `:id` с `role='admin'`.

- **Path:** `id` — uuid садика (валидируется `ParseUUIDPipe`).
- **Query (опционально):** `is_active` — boolean (`true`/`false`, class-transformer coercion). Отсутствует → возвращаются ВСЕ admin'ы (активные + деактивированные).
- **Реализация:** `staff.listByKindergarten(id, { role: 'admin', isActive: query.is_active })`. Поля `full_name`/`phone`/`locale` берутся из связанного `users` (staff-строка, созданная через kg-admin flow, не денормализует эти поля).
- **Response 200** — plain array (НЕ offset-paginated):

```json
[
  {
    "staff_member_id": "e2e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "user_id": "d3e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "full_name": "Айгерим Нурланкызы",
    "phone": "+77011112233",
    "locale": "ru",
    "is_active": true,
    "hired_at": "2026-04-28",
    "fired_at": null,
    "created_at": "2026-04-28T10:00:00.000Z"
  }
]
```

`hired_at` — `YYYY-MM-DD` или `null`; `fired_at` — `YYYY-MM-DD` или `null`; `created_at` — ISO-8601.

- **Errors:** 404 `kindergarten_not_found` (садик `:id` не существует); 401 (нет/невалидный bearer); 403 (роль не super_admin/support).

##### POST `/saas/kindergartens/:id/admins`

Добавляет ещё одного admin'а в существующий садик.

- **Path:** `id` — uuid садика (`ParseUUIDPipe`).
- **Body** (`AddKindergartenAdminDto`, snake_case):

```json
{ "full_name": "Жанна Серикова", "phone": "+77011115566", "locale": "kk" }
```

`full_name` — string (required); `phone` — string E.164 `^\+[1-9]\d{1,14}$` (required); `locale` — `'ru' | 'kk'` (optional, default `ru`).

- **Логика (в request-scoped TX):**
  1. `kindergartens.findById(:id)` → отсутствует → **404 `kindergarten_not_found`**.
  2. `kg.isArchived` → **409 `kindergarten_archived`**.
  3. DTO-валидация (`ValidationPipe`): невалидный `phone`/`locale` отвергается class-validator ДО сервиса → **422** (стандартный nest validation envelope: `{ "status": 422, "errors": { "phone": "invalid_phone_format" } }` — НЕ `invariant_violation`). Сервисный `Phone.parse` / `Locale.parse` (достижим только если DTO прошёл) бросает `InvariantViolationError` → **400**, где `error`/`message` — описательный код инварианта (напр. `phone must be E.164`), а не литерал `invariant_violation`.
  4. find-or-create `users` по `phone` — существующий user НЕ перезаписывается (full_name/locale патчатся только у только что созданного).
  5. строгий conflict-check `staff.findByUserAndKindergarten(userId, :id)` (любой `is_active`): строка с `role='admin'` → **409 `admin_already_exists`**; строка с `role≠'admin'` → **409 `staff_already_exists`**; нет строки → продолжаем.
  6. `staff.create({ role: 'admin', hiredAt: now })`.
  7. Best-effort invite-SMS (`buildAdminInviteSms`) — не откатывает TX, не бросает; результат в `invite_sms_sent`.
- **Response 201:**

```json
{
  "kindergarten_id": "7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
  "user": {
    "id": "d3e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "phone": "+77011115566",
    "full_name": "Жанна Серикова",
    "locale": "kk"
  },
  "staff_member": {
    "id": "e2e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
    "role": "admin",
    "is_active": true,
    "hired_at": "2026-04-28",
    "created_at": "2026-04-28T10:00:00.000Z"
  },
  "invite_sms_sent": true
}
```

- **Errors:** **422** class-validator (невалидный `phone`/`locale` отвергнут DTO; тело — `{ "status": 422, "errors": { "<field>": "<constraint>" } }`, НЕ `invariant_violation`); **400** `<invariant-code>` (сервисный `Phone.parse`/`Locale.parse`, достижим только если DTO прошёл — `error`/`message` это описательный код инварианта, не литерал `invariant_violation`); 401; 403; 404 `kindergarten_not_found`; 409 `kindergarten_archived`; 409 `admin_already_exists` (уже есть admin-строка для пары; включая race losing-request); 409 `staff_already_exists` (есть non-admin staff-строка для пары). Тело доменной ошибки (4xx через `DomainErrorFilter`): `{ "statusCode": <int>, "error": "<code>", "message": "<code>" }`.

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

### 1.6 Billing Operations (Super-Admin)

**Auth:** `@SuperAdminScope()` (bypass RLS). Используется для ручного триггера cron и demo/test.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/saas/billing/monthly-run` | Ручной триггер ежемесячной генерации инвойсов. Body: `{period_start: '2026-06-01', kindergarten_id?: 'uuid'}`. Если `kindergarten_id` не указан — обходит все активные садики (cross-tenant). Вызывает `monthly-billing.processor` логику напрямую без BullMQ (синхронный ответ с итогом). Идемпотентен: advisory lock per `(kg_id, period_start)` + `existsAnyForPeriod` short-circuit пропускает уже сгенерированные периоды. Response 200: `{triggered_at, period_start, kindergartens_processed: int, invoices_created: int, skipped_already_generated: int}`. Errors: 400 `invalid_period_start` (не первое число месяца). |
| POST | `/saas/billing/discount-expire-run` | Ручной триггер `discount:expire` процессора (B16). Body: `{kindergarten_id?: 'uuid'}`. Истекает `status='active'` скидки, у которых `valid_until < NOW()` → `status='expired'`. Синхронный ответ. Response 200: `{triggered_at, expired_count: int}`. |
| POST | `/saas/billing/overdue-run` | Ручной триггер `OverdueInvoiceProcessor` (B22a T1). Body: `{now?: 'YYYY-MM-DDTHH:mm:ssZ'}` (опциональный override `now` для бэк-фила; default — server-time). Cross-tenant: для каждого активного садика делает атомарный `UPDATE invoices SET status='overdue' WHERE status IN ('pending','partial') AND due_date < $now::date RETURNING id, child_id, amount_after_discount, due_date` + emit `invoice.overdue` outbox event для каждой перевёрнутой строки в той же TX. Идемпотентен: повторный запуск исключает уже-`overdue` строки. Response 202: `{job_id, status: 'enqueued'}`. Cron: `0 3 * * *` Asia/Almaty (gated `BILLING_OVERDUE_CRON != 'disabled'`). |

### 1.7 Content Operations (Super-Admin) — B17

**Auth:** `@SuperAdminScope()` (bypass RLS). Ручные триггеры cron-задач контента.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/saas/content/birthday-run` | Ручной триггер `birthday-generation` процессора. Body: `{kindergarten_id?: 'uuid', date?: 'YYYY-MM-DD'}`. Если `kindergarten_id` не указан — обходит все активные садики. `date` — дата генерации (default: today в Asia/Almaty). Идемпотентен: пропускает если уже существует пост с `metadata.child_id = X` за эту дату. Response 200: `{triggered_at, kindergartens_processed: int, posts_created: int, posts_skipped: int}`. |
| POST | `/saas/content/story-cleanup-run` | Ручной триггер `story-cleanup` процессора. Body: `{kindergarten_id?: 'uuid'}`. Удаляет `group_stories` с `expires_at <= NOW()`, вызывает `FileStoragePort.delete` для каждого. Response 200: `{triggered_at, deleted_count: int}`. |
| POST | `/saas/content/publish-scheduled-run` | Ручной триггер `content-publish` процессора. Body: `{kindergarten_id?: 'uuid'}`. Публикует `content_posts` с `status='scheduled'` и `scheduled_for <= NOW()`. Response 200: `{triggered_at, published_count: int}`. |

### 1.8 Kaspi Pay — Global Config (Super-Admin) — B24

**Auth:** `@SuperAdminScope()` (bypass RLS). Глобальный конфиг Kaspi-клиента — single-row `kaspi_global_config`, общий для всех садиков.

**Зачем:** Kaspi блокирует устаревший **билд** приложения (`OldVersionToUpdate`) — гейт смотрит на `app_build`, строку `app_version` игнорирует (эмпирически, floor сейчас = 1071). При блокировке суперадмин поднимает `app_build` здесь — **без передеплоя**, и все садики чинятся.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/saas/kaspi/config` | Текущий глобальный конфиг. Response 200: `{app_version, app_build, platform_ver, model, brand, ua_native, ua_browser, entrance_url, mtoken_url, qrpay_url, updated_by, updated_at}`. |
| PUT | `/saas/kaspi/config` | Обновить конфиг (частично). Body: `{app_version?, app_build?, platform_ver?, model?, brand?, ua_native?, ua_browser?, entrance_url?, mtoken_url?, qrpay_url?}`. Инвалидирует кэш во всех Kaspi-адаптерах. Response 200: обновлённый конфиг. Errors: 422 validation. |
| POST | `/saas/kaspi/version-probe` | **SMS-free** проверка билда против гейта Kaspi. Body: `{app_build?, app_version?}` (default — текущие из config). Дёргает Kaspi `entrance/step` (init, SMS НЕ шлётся) и смотрит `OldVersionToUpdate`. Response 200: `{build, accepted: bool, alarm?: 'OldVersionToUpdate'}`. Используется как health-check (cron шлёт его текущим `app_build` → алерт суперадмину при `accepted=false`). |

**Notes:**
- Probe детерминированный и SMS-бесплатный (гейт срабатывает до отправки кода) — можно гонять для бинарного поиска текущего floor.
- Cron `kaspi:version-health` (SMS-free probe, opt-in через `KASPI_VERSION_HEALTH_CRON=enabled`) периодически пробит сконфигурированный `app_build` и кэширует `{build, accepted, alarm, checkedAt}` в Redis (key `kaspi:version_health`, TTL `KASPI_VERSION_HEALTH_TTL_SECONDS`, default 1h → залежавшийся снимок отдаётся как `unknown`). Крон работает только в API-процессе (`NestScheduleModule.forRoot()` подключён лишь в `AppModule`, не в воркере).
- Результат отдаётся на `GET /api/v1/health/ready` как `checks.kaspi` (`up` = билд принят, `down` = `OldVersionToUpdate` заблокирован, `unknown` = ещё не пробили / снимок устарел). Это **INFORMATIONAL** — не влияет на top-level `status`/k8s-readiness; ops/суперадмин смотрят `checks.kaspi`, чтобы чинить билд проактивно (поднять `app_build` через `PUT /saas/kaspi/config`). Outage Kaspi не флипает гейт в `down` — снимок не перезаписывается, только явный `OldVersionToUpdate` = заблокирован.
- Note: более богатый in-product алерт суперадмину — отложенный follow-up (канала нотификаций для `saas_users` пока нет).

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

**`ChildDto` display-overlay (B-N2):** наряду с `current_group_id` карточка ребёнка несёт computed `current_group_name` (`currentGroupId → groups.name`; `null`, если группа не назначена / не найдена / имя пустое). Резолвится батчем в `ChildService` (без N+1), отдаётся всеми эндпоинтами, возвращающими `ChildDto` (admin CRUD + `GET /parent/children`, `GET /parent/children/:id`). На cross-tenant fan-out родителя (`GET /parent/children` без `kindergarten_id` в JWT) поле = `null` — резолв пропущен, чтобы не открывать RLS-дыру (корректность > полнота).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/children` | Список (фильтр по `status`, `current_group_id`, поиск по ФИО/ИИН). Каждый `ChildDto` несёт `current_group_name` (см. выше). |
| POST | `/admin/children` | Создать карточку вручную (вне enrollment flow). |
| GET | `/admin/children/:id` | Полная карточка: гардианы, группа, история групп, timeline (preview), платежи (preview), диагностики (preview). |
| PATCH | `/admin/children/:id` | Обновить ФИО, ИИН, DOB, photo, `medical_notes`, `allergy_notes`. |
| POST | `/admin/children/:id/transfer-group` | Перевод в другую группу. Создаёт запись в `child_group_history`. Emits `child.transferred` через outbox (менторы старой+новой группы + guardians). |
| POST | `/admin/children/:id/activate` | Активировать карточку (`card_created → active`), ставит `enrollment_date`. **Требует активный `tariff_assignment`** на текущую дату — иначе 409 `child_activation_requires_tariff`. Пишет `card_created→active` в `child_status_history`. См. §2.7.2. |
| POST | `/admin/children/:id/archive` | Архивировать ребёнка. Закрывает `tariff_assignments`, enqueue BullMQ `lifecycle:pro-rata-refund`. |
| POST | `/admin/children/:id/reactivate` | Реактивировать ребёнка. Возврат в `status='active'`. |
| GET | `/admin/children/:id/status-history` | История изменений `children.status` (audit). Paginated `?limit=&offset=`. Response: `[{id, previous_status, new_status, previous_archive_reason, archive_reason, changed_by_user_id, changed_at}]` отсортирован `changed_at DESC`. См. §2.7.5. |
| GET | `/admin/children/:id/guardians` | Все guardians ребёнка (+ статус одобрения, `has_approval_rights`). Каждый `GuardianDto` несёт display-поля `user_full_name` / `user_phone` (nullable), резолвящиеся из связанной строки `users` по `child_guardians.user_id` — тот же приём, что в `/admin/staff` (`full_name`/`phone` из `users`). `null`, если у юзера, приглашённого по телефону, ещё не заполнен профиль. Поля присутствуют во всех ответах с `GuardianDto` (admin + parent approval/child эндпоинты). |
| POST | `/admin/children/:id/guardians` | Добавить guardian вручную (админ может создать primary с самого начала). |
| POST | `/admin/children/:id/guardians/:guardianId/approve` | **Одобрить заявку родителя из админки** (без участия primary-опекуна). `pending_approval → approved`, `approved_by = текущий админ`. Body опц. `{ grant_approval_rights?: boolean }`. Для `secondary`/`nanny` — грант под cap ≤2/ребёнка; `primary` всегда получает `has_approval_rights` (и пропускает cap, паритет с OTP auto-approve). Errors: 404 `guardian_not_found`, 409 `max_approval_rights_exceeded`, 422 `invalid_guardian_status_transition` (строка не в `pending_approval`). |
| POST | `/admin/children/:id/guardians/:guardianId/reject` | **Отклонить заявку родителя из админки** (пара к approve). `pending_approval → rejected` (терминально). Без body. Errors: 404 `guardian_not_found`, 422 `invalid_guardian_status_transition` (строка не в `pending_approval`). |
| PATCH | `/admin/children/:id/guardians/:guardianId` | Изменить `role`, `can_pickup`. Изменение `has_approval_rights` — через approve выше (admin) или Primary Guardian's approval flow (см. Parent API). |
| POST | `/admin/children/:id/guardians/:guardianId/revoke` | Отозвать доступ (`revoked_at`, `revoked_by`). |
| GET | `/admin/children/:id/group-history` | История переводов. |
| GET | `/admin/children/:id/timeline` | Вся timeline ребёнка. |

#### 2.7.1 POST `/admin/children/:id/transfer-group`

**Auth:** `admin` role + `KindergartenScopeGuard`.

**Request body:**
```json
{ "to_group_id": "550e8400-e29b-41d4-a716-446655440010", "reason": "Возрастная группа" }
```
`to_group_id` — обязательное, UUID; `reason` — опциональное, text.

**Success 200:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "full_name": "Алишер Нурмагамбетов",
  "current_group_id": "550e8400-e29b-41d4-a716-446655440010",
  "group_history_entry_id": "550e8400-e29b-41d4-a716-446655440099"
}
```

**Errors:** 400 (validation), 401, 403, 404 `child_not_found`, 404 `group_not_found`, 409 `child_already_in_group`, 422, 429.

**Side effects:** INSERT `child_group_history`; INSERT `notification_outbox (event_key='child.transferred')` в той же TX (menторы старой+новой группы + approved guardians, nanny исключены).

---

#### 2.7.2 POST `/admin/children/:id/activate`

Ручная активация карточки: первый forward-переход стейт-машины `card_created → active` (доменный метод `Child.activate()`). Выводит наружу единственный недостающий переход — без него вручную созданный ребёнок навсегда заморожен в `card_created` (archive требует `active`, reactivate требует `archived`).

**Auth:** `admin` role + `KindergartenScopeGuard`.

**Request body:** пустой `{}`.

**Precondition (зафиксировано):** у ребёнка должен быть активный `tariff_assignment`, покрывающий текущую дату (`valid_from <= now AND (valid_until IS NULL OR valid_until >= now)`). Иначе — 409 `child_activation_requires_tariff`. Гарантия: `active`-ребёнок всегда биллабелен (месячный крон итерирует `tariff_assignments`); активный без тарифа = «бесплатный» ребёнок, которого крон молча игнорирует. Назначить тариф: `POST /admin/tariff-assignments` (тариф можно назначить и на `card_created`, статус не проверяется). Порядок: создать карточку → назначить тариф → активировать.

**Success 200:** `ChildDto` со `status: "active"` и проставленным `enrollment_date` (= дата активации).
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "full_name": "Алишер Нурмагамбетов",
  "status": "active",
  "enrollment_date": "2026-06-10"
}
```

**Errors:**
| HTTP | Code | Условие |
|---|---|---|
| 401 | `unauthorized` | Нет/истёк токен |
| 403 | `forbidden` | Нет роли admin |
| 404 | `child_not_found` | `:id` не существует или не принадлежит kg |
| 409 | `child_activation_requires_tariff` | Нет активного `tariff_assignment` на текущую дату |
| 422 | `invalid_child_status_transition` | `status` не равен `card_created` (уже `active` или `archived`) |
| 429 | `rate_limit_exceeded` | Слишком много запросов |

**Side effects (в одной TX):**
- `UPDATE children SET status='active', enrollment_date=NOW(), updated_at=NOW() WHERE status='card_created'` (conditional UPDATE — race-safe).
- INSERT `child_status_history (previous_status='card_created', new_status='active', changed_by_user_id=<req.user.sub>)` атомарно с UPDATE.
- Нотификация **не** эмитится (события `child.activated` пока нет; активация — внутренний admin-flip). Тариф/первый инвойс **не** создаются автоматически.

---

#### 2.7.3 POST `/admin/children/:id/archive`

**Auth:** `admin` role + `KindergartenScopeGuard`.

**Request body:**
```json
{ "archive_reason": "Переезд семьи в другой город" }
```
`archive_reason` — обязательное, text, 1..500 символов.

**Success 200:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "full_name": "Алишер Нурмагамбетов",
  "status": "archived",
  "archived_at": "2026-05-12T10:00:00.000Z",
  "archive_reason": "Переезд семьи в другой город"
}
```

**Errors:**
| HTTP | Code | Условие |
|---|---|---|
| 400 | `validation_error` | Невалидный body |
| 401 | `unauthorized` | Нет/истёк токен |
| 403 | `forbidden` | Нет роли admin |
| 404 | `child_not_found` | `:id` не существует или не принадлежит kg |
| 409 | `child_already_archived` | `status` уже `archived` |
| 422 | `archive_reason_required` | `archive_reason` отсутствует или пустая строка |
| 429 | `rate_limit_exceeded` | Слишком много запросов |

**Side effects (в одной TX):**
- `UPDATE children SET status='archived', archived_at=NOW(), archive_reason=<reason>`.
- `UPDATE tariff_assignments SET valid_until=CURRENT_DATE WHERE child_id=:id AND (valid_until IS NULL OR valid_until > CURRENT_DATE)`.
- INSERT `notification_outbox (event_key='child.archived')` — guardians (кроме nanny).
- BullMQ enqueue `lifecycle:pro-rata-refund {kindergartenId, childId, archivedAt}` внутри той же TX с `delay: 5s`. Worker всегда видит закомиченную строку: (1) `delay` даёт TX 5 секунд на commit; (2) если worker всё-таки опередил commit, processor бросает retryable `ChildNotYetArchivedError` в 60-секундном grace-окне, BullMQ ретраит exp-backoff (1m/2m/4m). После grace процессор фиксирует skip (producer TX откатился, job orphan).

---

#### 2.7.4 POST `/admin/children/:id/reactivate`

**Auth:** `admin` role + `KindergartenScopeGuard`.

**Request body:** пустой `{}`.

**Success 200:**
```json
{
  "child": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "full_name": "Алишер Нурмагамбетов",
    "status": "active"
  },
  "requires_new_tariff_assignment": true
}
```
`requires_new_tariff_assignment: true` — всегда `true`; сигнал для UI создать новый тарифный план через `POST /admin/tariff-assignments`.

**Errors:**
| HTTP | Code | Условие |
|---|---|---|
| 401 | `unauthorized` | Нет/истёк токен |
| 403 | `forbidden` | Нет роли admin |
| 404 | `child_not_found` | `:id` не существует или не принадлежит kg |
| 409 | `child_not_archived` | `status` не равен `archived` |
| 429 | `rate_limit_exceeded` | Слишком много запросов |

**Side effects (в одной TX):**
- `UPDATE children SET status='active', archived_at=NULL, archive_reason=NULL`.
- INSERT `notification_outbox (event_key='child.reactivated')` — guardians (кроме nanny).
- Новый `tariff_assignments` **не создаётся автоматически**.

#### 2.7.5 GET `/admin/children/:id/status-history` (B22a)

**Auth:** `admin` role + `KindergartenScopeGuard`.

**Query:** `limit?` (default 50, max 200), `offset?` (default 0).

**Success 200:**
```json
{
  "items": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440099",
      "previous_status": "archived",
      "new_status": "active",
      "previous_archive_reason": "Переезд семьи в другой город",
      "archive_reason": null,
      "changed_by_user_id": "550e8400-e29b-41d4-a716-446655440007",
      "changed_at": "2026-05-12T14:30:00.000Z"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440098",
      "previous_status": "active",
      "new_status": "archived",
      "previous_archive_reason": null,
      "archive_reason": "Переезд семьи в другой город",
      "changed_by_user_id": "550e8400-e29b-41d4-a716-446655440007",
      "changed_at": "2026-05-10T10:00:00.000Z"
    }
  ],
  "total": 2
}
```

**Errors:** 401 `unauthorized`, 403 `forbidden`, 404 `child_not_found`, 429 `rate_limit_exceeded`.

**Notes:**
- История переходов хранится в `child_status_history` (RLS-scoped, REVOKE TRUNCATE — rows никогда не удаляются для compliance).
- `previous_archive_reason` зафиксирован ДО того как `Child.reactivate()` сбрасывает `archive_reason` (audit гарантия).
- `changed_by_user_id` — `users.id` инициатора (не `staff_members.id`).
- Pagination через `offset` (per-child объём маленький, cursor не нужен).
- Mentor + parent не имеют доступа к этому endpoint — статус в текущем виде они видят через основной child-detail.

---

**Error codes (§2.7):** `child_not_found`(404), `child_already_archived`(409), `child_not_archived`(409), `archive_reason_required`(422), `child_already_in_group`(409), `group_not_found`(404).

### 2.8 Schedule (Templates + Activity Events)

**Auth:** `admin` role, `kindergarten_id` в JWT.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/schedule/templates` | Список шаблонов. Query: `group_id?`, `is_active?`. Response: `[{id, name, group_id, recurrence, is_active, valid_from, valid_until, slots_count}]`. |
| POST | `/admin/schedule/templates` | Создать шаблон. Body: `{group_id?, name, recurrence='weekly', valid_from, valid_until?}`. Response 201: полный объект шаблона. Errors: 400 `invalid_date_range`, 404 `group_not_found`. |
| PATCH | `/admin/schedule/templates/:id` | Обновить `name?`, `is_active?`, `valid_until?`. Errors: 404 `schedule_template_not_found`. |
| GET | `/admin/schedule/templates/:id/slots` | Слоты шаблона, отсортированные по `day_of_week`, `start_time`. Response: `[{id, day_of_week, start_time, end_time, activity_name, category, location_id, description}]`. `category` — enum `lesson|activity|meal|sleep` (всегда присутствует). Errors: 404 `schedule_template_not_found`. |
| POST | `/admin/schedule/templates/:id/slots` | Добавить слот. Body: `{day_of_week, start_time, end_time, activity_name, category?, location_id?, description?}`. `day_of_week` — enum `mon|tue|wed|thu|fri|sat|sun`. `category` — enum `lesson|activity|meal|sleep`, серверный default `'activity'`; невалидное значение → 400. Response 201. Errors: 404 `schedule_template_not_found`, 404 `location_not_found`, 409 `slot_time_conflict` (partial-unique `(template_id, day_of_week, start_time)`). |
| PATCH | `/admin/schedule/templates/:id/slots/:slotId` | Обновить поля слота (включая `category?` — enum `lesson|activity|meal|sleep`). Errors: 404 `schedule_template_not_found`, 404 `slot_not_found`, 409 `slot_time_conflict`. |
| DELETE | `/admin/schedule/templates/:id/slots/:slotId` | Удалить слот. Errors: 404 `schedule_template_not_found`, 404 `slot_not_found`. |
| GET | `/admin/schedule/week-snapshots` | Флаги наличия расписания по неделям. Query: `group_id?`, `week_start_date_from?`, `week_start_date_to?`. Response: `[{id, group_id, week_start_date, source, copied_from?}]`. |
| POST | `/admin/schedule/week-snapshots/copy` | Ручной запуск копирования расписания с указанной недели на следующую (то что делает cron `schedule:auto-copy`). Body: `{group_id, source_week_start_date}`. Идемпотентен: если снапшот уже существует — возвращает 200 с существующим. Response: `{snapshot, activity_events_created: N}`. Errors: 404 `group_not_found`, 404 `source_week_snapshot_not_found`. |
| GET | `/admin/schedule/activity-events` | Список `activity_events`. Query: `group_id?`, `date_from`, `date_to`, `status?`. Response: `[{id, group_id, template_slot_id?, activity_name, category, location_id?, location_name?, starts_at, ends_at?, status, created_by?, notes?}]`. `category` — enum `lesson|activity|meal|sleep` (копируется из слота при проекции; ad-hoc → серверный default `'activity'`, принимается опционально в POST/PATCH `activity-events`). `location_name` — computed display-overlay (`locationId → locations.name`); `null`, если `location_id` пуст / локация не найдена / имя пустое. |

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

### 2.10 Content (B17)

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`.

**ENUMs:** `content_type`: `news` | `menu` | `schedule_pub` | `qundylyq` | `birthday`. `content_target_type`: `all` | `group` | `child`. `content_status`: `draft` | `scheduled` | `published`.

**Инвариант таргетинга:** `target_type='child'` ⇒ `target_child_id` обязателен; `target_type='group'` ⇒ `target_group_id` обязателен; `target_type='all'` ⇒ оба поля null.

**Статус-машина:** `draft → scheduled → published` (только вперёд; `published` терминальный; удаление только из `draft`).

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| POST | `/admin/content` | admin | Создать черновик. `multipart/form-data`. |
| GET | `/admin/content` | admin | Список постов с фильтрами + cursor-пагинация. |
| GET | `/admin/content/:id` | admin | Детали поста. |
| PATCH | `/admin/content/:id` | admin | Обновить (только `draft` / `scheduled`). `multipart/form-data`. |
| DELETE | `/admin/content/:id` | admin | Удалить (только `draft`). |
| POST | `/admin/content/:id/publish` | admin | Немедленная публикация (`draft` или `scheduled` → `published`). |
| POST | `/admin/content/:id/schedule` | admin | Запланировать публикацию (`draft` → `scheduled`). |

**`POST /admin/content` — тело запроса (`multipart/form-data`):**

| Поле | Тип | Обязательно | Пример |
|---|---|---|---|
| `content_type` | `news\|menu\|schedule_pub\|qundylyq\|birthday` | да | `"news"` |
| `target_type` | `all\|group\|child` | да | `"group"` |
| `target_group_id` | uuid | если `target_type='group'` | `"c1d2e3f4-..."` |
| `target_child_id` | uuid | если `target_type='child'` | `"a1b2c3d4-..."` |
| `title_i18n` | JSON string `{ru, kz}` | нет | `"{\"ru\":\"Новость\",\"kz\":\"Жаңалық\"}"` |
| `body_i18n` | JSON string `{ru, kz}` | нет | `"{\"ru\":\"Текст\",\"kz\":\"Мәтін\"}"` |
| `scheduled_for` | ISO timestamp | нет (нужен для schedule) | `"2026-06-01T07:00:00+05:00"` |
| `metadata` | JSON string | нет | `"{\"theme\":\"spring\"}"` |
| `file` | file (image/video) | нет | — |

**`POST /admin/content` — ответ 201:**

```json
{
  "id": "uuid",
  "kindergarten_id": "uuid",
  "content_type": "news",
  "target_type": "group",
  "target_group_id": "uuid",
  "target_child_id": null,
  "title_i18n": { "ru": "Новость", "kz": "Жаңалық" },
  "body_i18n": { "ru": "Текст", "kz": "Мәтін" },
  "media_urls": [],
  "metadata": null,
  "scheduled_for": null,
  "published_at": null,
  "status": "draft",
  "created_by": "uuid",
  "created_at": "2026-06-01T07:00:00.000Z",
  "updated_at": "2026-06-01T07:00:00.000Z"
}
```

**`GET /admin/content` — query-параметры:**

| Параметр | Тип | Назначение |
|---|---|---|
| `content_type` | enum | Фильтр по типу |
| `status` | enum | Фильтр по статусу |
| `target_type` | enum | Фильтр по таргетингу |
| `target_group_id` | uuid | Фильтр по группе |
| `target_child_id` | uuid | Фильтр по ребёнку |
| `scheduled_from` | ISO date | Начало диапазона `scheduled_for` |
| `scheduled_to` | ISO date | Конец диапазона `scheduled_for` |
| `published_from` | ISO date | Начало диапазона `published_at` |
| `published_to` | ISO date | Конец диапазона `published_at` |
| `cursor` | string | Cursor-пагинация (last seen `id`) |
| `limit` | int | Default 20, max 100 |

**`POST /admin/content/:id/schedule` — тело:**

```json
{ "scheduled_for": "2026-06-05T07:00:00+05:00" }
```

Ответ 200: обновлённый объект поста. Errors: 404 `content_post_not_found`, 409 `content_post_status_invalid` (не в `draft`), 422 validation.

**Error map (§2.10):**

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `file_upload_error` | Ошибка при сохранении файла через `FileStoragePort` |
| 400 | `media_type_invalid` | MIME-тип не `image/*` и не `video/*` |
| 404 | `content_post_not_found` | Пост не найден в kg |
| 409 | `content_post_status_invalid` | Переход из несовместимого статуса (`PATCH` из `published`, `DELETE` из `scheduled`/`published`) |
| 422 | `content_target_invalid` | `target_type='child'` без `target_child_id` или `target_type='group'` без `target_group_id` |
| 422 | validation | Невалидные поля DTO |

### 2.11 Qundylyq (подтип content)

Qundylyq реализуется как `content_posts` с `content_type='qundylyq'`. Используются те же endpoints `POST /admin/content`, `PATCH /admin/content/:id`, `POST /admin/content/:id/publish`. Дополнительный helper:

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| GET | `/admin/qundylyq/current` | admin | Текущий активный Qundylyq (тема месяца, `status='published'`, последний по `published_at`). Response: content_post объект или `null`. |

### 2.12 Payments & Invoices (просмотр)

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/invoices` | Список инвойсов. Query: `status`, `due_date` (ISO date), `child_id` (uuid), `invoice_type` (`monthly`/`prepayment_3m`/…/`late_pickup_fee`/`other`). Response: `[{id, kindergarten_id, child_id, payment_account_id, tariff_plan_id, invoice_type, period_start, period_end, amount_due, discount_pct, discount_reason, amount_after_discount, status, due_date, description, prorated_for_days, created_at, updated_at}]`. |
| GET | `/admin/invoices/:id` | Детали инвойса + `invoice_line_items` + связанные `payments`, `refunds`, `fiscal_receipts`, применённые `custom_discount_applications`. |
| POST | `/admin/invoices` | Разовое начисление (доп. услуга). Body: `{child_id, invoice_type, amount_due, due_date, description?, period_start?, period_end?, line_items?: [{description, tariff_plan_id?, quantity, unit_price}]}`. Response 201: invoice object. Errors: 404 `child_not_found`, 422 validation. |
| POST | `/admin/invoices/:id/manual-mark-paid` | Ручная отметка оплаты наличкой. Создаёт `payments` с `provider='cash'`, `status='completed'`, применяет `Invoice.applyPayment`. Conditional UPDATE WHERE status IN ('pending','partial') RETURNING *; 409 `invoice_already_paid` при race. Response 200: `{invoice_id, payment_id, new_status}`. Errors: 404 `invoice_not_found`, 409 `invoice_already_paid`. |
| POST | `/admin/invoices/:id/cancel` | Отменить инвойс. Conditional UPDATE WHERE status IN ('pending','partial') RETURNING *. Response 200: `{id, status: 'cancelled'}`. Errors: 404 `invoice_not_found`, 409 `invoice_status_invalid`. |
| GET | `/admin/payments` | Список платежей. Query: `provider`, `status`, `child_id`, `from` (ISO date), `to` (ISO date). Response: `[{id, kindergarten_id, invoice_id, child_id, payer_user_id, amount, provider, provider_txn_id, idempotency_key, status, paid_at, created_at}]`. |
| GET | `/admin/payments/:id` | Детали платежа (включая `provider_payload`). |

**Error map (§2.12):**

| HTTP | `error` | Когда |
|---|---|---|
| 404 | `invoice_not_found` | Инвойс не найден в kg |
| 404 | `child_not_found` | Ребёнок не найден в kg |
| 409 | `invoice_already_paid` | `manual-mark-paid` когда status уже `paid` |
| 409 | `invoice_status_invalid` | `cancel` из несовместимого состояния (`paid`/`refunded`/`cancelled`) |
| 422 | validation | Невалидные поля DTO |

### 2.13 Tariffs (Billing)

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/tariff-plans` | Список тарифов. Query: `is_active` (bool), `tariff_type`. Response: `[{id, kindergarten_id, name, description, tariff_type, amount, currency, applies_to, group_id, age_min_months, age_max_months, is_active, valid_from, valid_until, discount_rules, created_at}]`. |
| POST | `/admin/tariff-plans` | Создать тарифный план. Body: `{name, tariff_type: 'monthly_base'\|'additional_service'\|'late_pickup'\|'meal_upgrade', amount: 120000, currency?: 'KZT', applies_to: 'child'\|'group'\|'age_range', age_min_months?, age_max_months?, group_id?, discount_rules?: {sibling_discount_pct?, prepay_3m_pct?, prepay_6m_pct?, prepay_12m_pct?, prepay_24m_pct?, benefit_category?}, valid_from: '2026-06-01', valid_until?}`. `prepay_24m_pct` опциональный — если задан, разблокирует `POST /parent/invoices/:id/pay/prepayment` с `months=24`. Response 201: tariff_plan object. Errors: 409 `tariff_plan_overlap` (non-overlapping valid_from..valid_until по kg+applies_to+group_id). |
| PATCH | `/admin/tariff-plans/:id` | Обновить поля. Body: `{name?, description?, amount?, discount_rules?, valid_until?}`. Нельзя менять `tariff_type`/`applies_to`/`group_id` (снять — через deactivate + create new). Response 200: updated object. Errors: 404 `tariff_plan_not_found`. |
| POST | `/admin/tariff-plans/:id/deactivate` | `is_active=false`. Не затрагивает существующие `tariff_assignments`. Response 200: `{id, is_active: false}`. Errors: 404 `tariff_plan_not_found`. |
| GET | `/admin/tariff-assignments` | Назначения тарифов на детей. Query: `child_id`, `tariff_plan_id`, `active_on` (ISO date — фильтр по valid_from..valid_until). Response: `[{id, kindergarten_id, child_id, tariff_plan_id, custom_amount, custom_reason, valid_from, valid_until, assigned_by, created_at}]`. |
| POST | `/admin/tariff-assignments` | Назначить тариф ребёнку. Body: `{child_id, tariff_plan_id, custom_amount?: 90000, custom_reason?: 'льгота многодетной семьи', valid_from: '2026-06-01', valid_until?}`. Защита от overlap по `(child_id, valid_from)`. Response 201: assignment object. Errors: 404 `tariff_plan_not_found`, 404 `child_not_found`, 404 `tariff_plan_inactive` (если `is_active=false`), 409 `tariff_assignment_overlap`. |
| PATCH | `/admin/tariff-assignments/:id` | Обновить / закрыть (`valid_until=today`). Body: `{custom_amount?, custom_reason?, valid_until?}`. Response 200: updated object. Errors: 404 `tariff_assignment_not_found`. |

**Error map (§2.13):**

| HTTP | `error` | Когда |
|---|---|---|
| 404 | `tariff_plan_not_found` | Тарифный план не найден в kg |
| 404 | `tariff_assignment_not_found` | Назначение не найдено в kg |
| 409 | `tariff_plan_inactive` | Попытка назначить неактивный план |
| 409 | `tariff_assignment_overlap` | Пересечение `valid_from..valid_until` для того же `child_id` |
| 409 | `tariff_plan_overlap` | Пересечение периодов для того же kg+applies_to+group_id |

### 2.14 Kindergarten Holidays

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`. Используется для pro-rata расчёта инвойсов (`is_billable=false` дни не считаются при расчёте периода).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/holidays` | Список праздников/нерабочих дней. Query: `year` (int), `month` (int). Response: `[{id, kindergarten_id, date, name: {ru, kz}, is_billable, created_at}]`. |
| POST | `/admin/holidays` | Создать. Body: `{date: '2026-06-16', name: {ru: 'День Республики', kz: 'Республика күні'}, is_billable?: false}`. UNIQUE `(kindergarten_id, date)`. Response 201: holiday object. Errors: 409 `holiday_already_exists` (дублирующийся `date` в kg). |
| PATCH | `/admin/holidays/:id` | Обновить. Body: `{name?: {ru?, kz?}, is_billable?}`. Response 200: updated object. Errors: 404 `holiday_not_found`. |
| DELETE | `/admin/holidays/:id` | Удалить запись. Response 204 No Content. Errors: 404 `holiday_not_found`. |

### 2.15 Refunds

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`. Статус-машина: `pending → approved → processed` (или `rejected` из `pending`).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/refunds` | Список возвратов. Query: `status` (`pending`/`approved`/`processed`/`rejected`), `payment_id`. Response: `[{id, kindergarten_id, payment_id, invoice_id, amount, reason, status, processed_by, provider_ref, created_at, updated_at}]`. |
| GET | `/admin/refunds/:id` | Детали возврата. |
| POST | `/admin/refunds` | Создать возврат (`status='pending'`). Body: `{payment_id, amount: 60000, reason: 'переплата за июнь'}`. Checks: `payment.status = 'completed'`, `amount <= payment.amount`. Response 201: refund object. Errors: 404 `payment_not_found`, 409 `refund_already_processed` (если уже существует completed refund для этого payment). |
| POST | `/admin/refunds/:id/approve` | Перевести в `approved` (первичная авторизация). Conditional UPDATE WHERE status='pending'. Response 200: `{id, status: 'approved', processed_by}`. Errors: 404 `refund_not_found`, 409 `refund_already_processed`. |
| POST | `/admin/refunds/:id/reject` | Терминально отклонить `pending` возврат. Body: `{reason: 'Возврат отклонён — недостаточно оснований'}` (1–500 символов). Платёж не затрагивается; `reason` колонка перезаписывается на rejection note. Response 200: refund object со `status='rejected'`. Errors: 404 `refund_not_found`, 409 `refund_already_processed` (не в `pending`). |
| POST | `/admin/refunds/:id/process` | Исполнить возврат через провайдера (`PaymentProviderPort.refund`). Атомарная TX: `refund.status='processed'` + `payment.status='refunded'` + `invoice.applyRefund` + `payment_account.balance` update. Body (опционально): `{acknowledge_kaspi_history_checked?: bool}`. **Для `kaspi_pay`-возвратов** `acknowledge_kaspi_history_checked=true` обязателен (K9): у Kaspi нет idempotency-ключа, поэтому слепой повтор после неоднозначного сбоя сети может привести к двойному возврату — оператор должен сначала проверить историю возвратов/return в приложении Kaspi. Для `mock`/`halyk_epay` поле игнорируется (idempotency-ключ `refund:<id>` делает повтор безопасным). Response 200: `{id, status: 'processed', provider_ref?}`. Errors: 400 `kaspi_refund_requires_history_ack` (`kaspi_pay`-возврат без подтверждения), 404 `refund_not_found`, 409 `refund_already_processed` (status уже `processed`). |

**Error map (§2.15):**

| HTTP | `error` | Когда |
|---|---|---|
| 404 | `refund_not_found` | Возврат не найден в kg |
| 404 | `payment_not_found` | Платёж не найден |
| 409 | `refund_already_processed` | Попытка дублирующего возврата или операции над обработанным |

### 2.16 Custom Discounts

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/custom-discounts` | Список (фильтры по статусу, периоду). |
| POST | `/admin/custom-discounts` | Создать (`status='draft'`): `name` {ru,kz}, `description`, `discount_type` (percentage/fixed_amount), `amount`, `conditions` JSONB (prepayment_months / siblings_count / age_range / benefit_category / payment_method / early_payment / birthday_month / date_range / first_invoice / all_of / any_of), `target_type` + `target_ids[]`, `valid_from/until`, `max_uses_per_child`, `total_max_uses`, `priority`, `stackable`, `notify_on_activation`, `notification_title/body_i18n`. |
| GET | `/admin/custom-discounts/:id` | Детали + статистика применений. |
| PATCH | `/admin/custom-discounts/:id` | Обновить (только для `draft`). |
| POST | `/admin/custom-discounts/:id/activate` | `status='active'`. Если `notify_on_activation` — enqueue `discount:notify` (push всем target-родителям). |
| POST | `/admin/custom-discounts/:id/pause` | `status='paused'`. |
| POST | `/admin/custom-discounts/:id/resume` | `status='active'` (из `paused`). Расширение сверх базового §2.16: paused → active resume transition. |
| POST | `/admin/custom-discounts/:id/cancel` | `status='cancelled'`. |
| GET | `/admin/custom-discounts/:id/applications` | Лог применений (`custom_discount_applications` с `invoice_id`, `child_id`, `amount_applied`). |

### 2.17 Fiscal Receipts (ОФД РК)

**B13:** `GET /admin/fiscal-receipts` — read-only stub. Возвращает список `fiscal_receipts` строк, созданных `MockFiscalReceiptAdapter` (все с `ofd_status='queued'`, `fiscal_sign='mock_*'`). Расширенные операции (retry, queue, report, real-provider) реализуются в **B15** (Phase B).

**B15+:** полный CRUD + retry + reporting.

| Метод | Путь | Назначение | Батч |
|---|---|---|---|
| GET | `/admin/fiscal-receipts` | Список чеков (фильтр по `status`, `provider`, `payment_id`, `fiscal_sign`). | B13 (stub) |
| GET | `/admin/fiscal-receipts/:id` | Детали + `ofd_payload`. | B15 |
| POST | `/admin/fiscal-receipts/:id/retry` | Ручной retry для `status='failed'`. Enqueue `fiscal:retry` (BullMQ с экспоненциальным backoff). Инкремент `retry_count`. | B15 |
| GET | `/admin/fiscal-receipts/queue` | Очередь pending/failed с ошибками (последний `error_message`, `retry_count`). | B15 |
| GET | `/admin/fiscal-receipts/report/monthly` | Ежемесячный отчёт по выданным чекам (totals, по провайдерам). | B15 |

### 2.18 Parent Requests (admin review)

**Auth:** `KindergartenScopeGuard` + `@Roles('admin')`. Видит все заявки kg (без role-фильтра).

**Display-overlays (B-N2):** `parent_request` несёт computed `recipient_staff_full_name` (`recipientStaffId → staff_members.full_name ?? users.full_name`) и `reviewed_by_full_name` (`reviewedBy → …`); `parent_request_message` несёт `author_full_name`, резолвящее того из (`author_user_id` | `author_staff_id`), что заполнен (`users.full_name` / staff-fallback). Все — `null` при пустом источнике / не найдено / имя пустое. Резолв батчем (без N+1). Те же поля — в staff (§3.9) и parent (§4.7) проекциях.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/parent-requests` | Все заявки kg (фильтр: `status`, `request_type`, `child_id`, `group_id`, `recipient_type`). Без ограничения по recipient. **B22b T7 M16:** cursor-paged по `(created_at DESC, id DESC)`; `next_cursor` — base64 JSON `{createdAt,id}`, передаётся `?cursor=` для следующей страницы; невалидный cursor → 400 `parent_request_cursor_invalid`. |
| GET | `/admin/parent-requests/:id` | Детали + `parent_request_messages`. |
| POST | `/admin/parent-requests/:id/accept` | Принять: body `{review_note?}`. Conditional UPDATE WHERE status='pending'; 409 при race. |
| POST | `/admin/parent-requests/:id/reject` | Отклонить: body `{review_note?}`. Conditional UPDATE WHERE status='pending'. |
| POST | `/admin/parent-requests/:id/messages` | Ответить в треде (staff-side message). Body: `{body, attachments?}`. |
| GET | `/admin/parent-requests/:id/messages` | Список messages (cursor-paged). |

### 2.19 Diagnostic Templates

Управление шаблонами — только admin. Специалисты читают шаблоны через `/staff/diagnostic-templates` (§3.10, read-only).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/diagnostic-templates` | Список шаблонов. Query: `specialist_type?`, `is_active?`. |
| POST | `/admin/diagnostic-templates` | Создать: body `{specialist_type, name, description?, schema}`. Schema JSONB: `{sections: [{title, fields: [{key, label, type, required, options?, min?, max?}]}]}`. `type`: `text\|number\|boolean\|select\|multiselect\|date\|scale`. |
| GET | `/admin/diagnostic-templates/:id` | Подробности. |
| PATCH | `/admin/diagnostic-templates/:id` | Обновить (auto-bump `version` при изменении `schema`). **B22a T7 (H12):** schema PATCH блокируется → 409 `template_has_entries`, если уже есть `diagnostic_entries` против шаблона (mutating schema invalidates persisted `data` payloads). Patch только `name`/`description`/`is_active` — допустим в любое время. |
| POST | `/admin/diagnostic-templates/:id/deactivate` | `is_active=false`. Существующие записи против этого шаблона сохраняются. |

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

**Display-overlays (B-N2):** `attendance_event` несёт computed `recorded_by_full_name` (`recordedBy → staff_members.full_name ?? users.full_name`) и `pickup_user_full_name` (`pickupUserId → users.full_name`, `null` на check-in / без pickup); `child_daily_status` несёт `set_by_full_name` (`setBy → staff_members.full_name ?? users.full_name`). Все — `null` при пустом источнике / не найдено / имя пустое. Резолв батчем в сервисе (без N+1).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/attendance-events` | Лог check-in/out (фильтр: `child_id`, `method`, диапазон дат). Каждое событие несёт `recorded_by_full_name` + `pickup_user_full_name` (см. выше). |
| PATCH | `/admin/attendance-events/:id` | Корректировка: `recorded_at`, `notes`, `pickup_user_id`. |
| GET | `/admin/daily-status` | Сводка `child_daily_status` на дату по садику. |
| GET | `/admin/daily-status/summary` | Агрегированная сводка отсутствий (для заявок vacation/day_off). |

### 2.22 Analytics / Dashboard

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/dashboard/summary` | Guard: `JwtAuthGuard, PendingRoleSelectGuard, RolesGuard` + `@Roles('admin','reception')`. Агрегат: `{active_children, enrollments_in_processing, invoices_overdue_count, invoices_overdue_amount, mtd_revenue, ytd_revenue, active_staff, active_groups}`. `mtd_revenue`/`ytd_revenue` — БРУТТО `SUM(payments.amount)` (`status='completed'`) за календарный месяц/год в Asia/Almaty (возвраты не вычитаются). `invoices_overdue_*` — инвойсы `due_date < сегодня(Asia/Almaty) AND status IN ('pending','partial')`. Деньги — целые тенге (number). |
| GET | `/admin/dashboard/attendance-today` | Параметры (опц.): `group_id` (UUID, snake_case — фильтр по `children.current_group_id`), `date` (YYYY-MM-DD, default = сегодня Asia/Almaty). Ответ: `{in_kindergarten, checked_out, absent, on_vacation, sick}`. `in_kindergarten`/`checked_out` — по последнему событию дня в `attendance_events`; `absent` — `child_daily_status='absent'` без check_in за день; `on_vacation`/`sick` — по `child_daily_status`. |
| GET | `/admin/dashboard/payments-overview` | Параметры: `from`, `to` (YYYY-MM-DD, обязательны; `to < from` → 400 `invalid_date_range`). Ответ: `{paid, pending, overdue, refunded}` (каждый `{count, amount}` по инвойсам, фильтр `period_start ∈ [from,to]`) + `by_provider: [{provider, count, amount}]` (платежи `status='completed'`, `paid_at ∈ [from,to]`, GROUP BY provider). |

### 2.23 Identity QR — Admin Controls

<!-- Implemented in B10 -->

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/admin/qr/revoke-all/:userId` | Auth: `JwtAuthGuard` + `KindergartenScopeGuard` + `AdminScope`. Tenant-scoped: target user должен быть активным `staff_member` в kg вызывающего админа ИЛИ approved+non-revoked `child_guardian` ребёнка из kg вызывающего админа — иначе 403 `user_no_relationship_to_kindergarten`. 404 `user_not_found` если userId не существует. Bulk-revoke всех активных токенов пользователя: DB `revoked_at = NOW()` для всех активных строк `user_qr_tokens WHERE user_id=:userId AND revoked_at IS NULL` + `DEL qr:user:{userId}:identity` (next user GET сразу mintsит fresh). Plaintext-keyed `qr:token:{plaintext}` НЕ удаляется (admin не имеет plaintext-токенов, только их хэши); cache-TTL ≤24h задаёт верхнюю границу stale-cache exposure; следующий скан попадает в DB-recheck и возвращает 410 `qr_token_revoked`. Security-recourse при подозрении на компрометацию QR. Response: `{revoked_count: number}`. |

### 2.24 Lifecycle DLQ — Admin Operator Surface (B22a)

<!-- Implemented in B22a — exposes BullMQ `lifecycle` queue failed jobs (pro-rata refund + future lifecycle processors) for operator triage. -->

**Auth:** `JwtAuthGuard` + `KindergartenScopeGuard` + `AdminScope`. Cross-kg listing допускается только super-admin'у; per-kg admin видит только jobs с `payload.kindergartenId` равным своему kg.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/admin/lifecycle/failed-jobs` | List failed BullMQ jobs from `lifecycle` queue. Query: `limit?` (default 50, max 200), `cursor?` (offset-based for BullMQ `getFailed(start, end)` API). Response: `{items: [{id, name, payload, failed_reason, attempts_made, timestamp, finished_on}], next_cursor?}`. Per-kg admin видит только items где `payload.kindergartenId` matches caller's kg; super-admin видит всё. |
| POST | `/admin/lifecycle/failed-jobs/:id/retry` | Re-enqueue failed job в `lifecycle` queue с тем же payload. Body пустой. Response 202: `{enqueued: true, job_id: string}`. Errors: 404 `lifecycle_job_not_found`, 409 `lifecycle_job_not_in_failed_state`, 403 `forbidden` (per-kg admin не имеет доступа к чужому kg job). |

**Errors:** 401, 403 `forbidden`, 404 `lifecycle_job_not_found`, 409 `lifecycle_job_not_in_failed_state`, 429.

**Notes:**
- Backed by `LifecycleJobsService` использующий `@nestjs/bullmq`'s `getFailed(start, end)` API; `removeOnFail: { age: 30 * 86400 }` (B21 T8) гарантирует что failed jobs живут 30 дней до auto-cleanup.
- Per-kg admin scoping реализуется в service-слое через payload-фильтр (BullMQ не знает о tenant'ах).
- Retry endpoint полезен после исправления transient bugs в processor'е — re-enqueue вместо ручного UPDATE на DB-rows.
- Полный список processor'ов в `lifecycle` queue: `pro-rata-refund` (B21). Будущие lifecycle-jobs наследуют этот же admin-surface.

### 2.25 Kaspi Pay — подключение мерчанта (B24)

<!-- B24 — SMS-онбординг кассирского аккаунта Kaspi Pay для садика. Per-tenant креды в kaspi_merchant_session. -->

**Auth:** `JwtAuthGuard` + `KindergartenScopeGuard` + `@Roles('admin')`. Креды пишутся в `kaspi_merchant_session` своего садика (RLS).

**Поток онбординга** — 3 шага SMS + finish; in-flight состояние между шагами в Redis (ключ по `processId`, TTL ~5 мин). ⚠️ `verify-otp` с валидным билдом шлёт **реальную SMS** кассиру — беречь попытки. Версия/билд приложения берётся из `kaspi_global_config` (§1.8).

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/admin/kaspi/connect/init` | Старт онбординга. Body пустой. Дёргает Kaspi `entrance/step` (SMS НЕ шлётся), кладёт в Redis `userToken` + draft device-fingerprint (свой на садик). Response 201: `{process_id}`. Errors: 409 `kaspi_already_connected` (есть active-сессия — сначала disconnect), 502 `kaspi_app_version_outdated` (гейт `OldVersionToUpdate` — суперадмину поднять `app_build`). |
| POST | `/admin/kaspi/connect/send-phone` | Body: `{process_id, phone}` — номер кассира. **Формат `phone` гибкий**: принимаются голый 10-значный национальный (`7011234567`), 11-значный с кодом страны (`77011234567`), `8`-префикс (`87011234567`) и E.164 (`+77011234567`). Бэкенд **нормализует к 10-значному национальному** перед вызовом Kaspi — это единственный формат, который Kaspi `EnterPhoneNumber` принимает; 11-значный Kaspi отвергает (`UserPhoneNumberDoesNotBelongToAnyOperator`). Триггерит SMS-код Kaspi. Response 200: `{process_id, sms_sent: true}`. Errors: 400 `kaspi_unknown_process` (нет/протух `process_id`), 400 `kaspi_invalid_phone` (не сводится к 10 цифрам — **в Kaspi не уходит**), 422 `invalid_phone_format` (DTO-валидация). |
| POST | `/admin/kaspi/connect/verify-otp` | Body: `{process_id, otp: '1234'}` — Kaspi присылает **4-значный** код (валидатор терпит 4–6 цифр). Подтверждает код → авто-`finish` (ECDH-обмен → `vtokenSecret`) → org-context → сохраняет `kaspi_merchant_session` (всё чувствительное enc), `status=active`. Response 200: `{connected: true, phone, org_name, profile_id}`. Errors: 400 `kaspi_unknown_process`, 401 `kaspi_otp_invalid`, 502 `kaspi_finish_failed`. |
| GET | `/admin/kaspi/status` | Текущее состояние подключения садика. Response 200: `{connected: bool, status: 'pending'\|'active'\|'expired'\|'revoked', phone?, org_name?, last_checked_at?}`. Никаких секретов в ответе. |
| POST | `/admin/kaspi/disconnect` | Отключить Kaspi: `status=revoked` (+ опц. logout в Kaspi). Реконнект = повторный онбординг (перезапись строки). Response 200: `{status: 'revoked'}`. Errors: 404 `kaspi_not_connected`. |

**Errors (§2.25):** 401, 403 `forbidden`, 400 `kaspi_unknown_process`, 400 `kaspi_invalid_phone`, 401 `kaspi_otp_invalid`, 409 `kaspi_already_connected`, 404 `kaspi_not_connected`, 422 `invalid_phone_format`, 502 `kaspi_app_version_outdated` / `kaspi_finish_failed`, 429.

> **Формат номера кассира (важно).** Kaspi `entrance/step` (`sn: EnterPhoneNumber`) принимает **только 10-значный национальный** номер (`7772270088`). 11-значная форма с кодом страны (`77772270088`) отвергается бизнес-ошибкой `UserPhoneNumberDoesNotBelongToAnyOperator` (всплывала как `kaspi_finish_failed`). Бэкенд нормализует любой ввод (`+7…`/`8…`/11-значный/10-значный) к 10 цифрам в `toKaspiNationalPhone()` перед запросом; не сводимый к 10 цифрам номер → `kaspi_invalid_phone` (400) **без обращения к Kaspi**.

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
| POST | `/staff/attendance/check-out` | Ручной check-out: `child_id`, `pickup_user_id` (guardian/trusted), `pickup_request_id` (если был OTP flow), `notes`. Ответ-событие несёт `recorded_by_full_name` + `pickup_user_full_name` (display-overlay). |
| PATCH | `/staff/attendance/:eventId` | Корректировка ранее сделанной записи (в окне той же смены). |
| GET | `/staff/attendance/today` | События сегодня по моим группам. |

### 3.4 Face ID (staff-facing)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/face-id/events` | Callback от камеры-экрана (shyraq-face-service): `camera_device_id`, `external_id` (или null), `confidence`, `spoof_score`, `photo_url`. Дедуп Redis `face:seen:*`. Создаёт `face_recognition_events` + (при match) `attendance_events`, `timeline_entries`, push/WS. Rate-limit 300/мин per camera_device_id. |
| GET | `/staff/face-id/events/recent` | Последние события (для Reception-мониторинга). |

### 3.5 Identity QR Scan

<!-- Implemented in B10 -->

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/qr/scan` | Сканирование QR пользователя. Auth: `JwtAuthGuard` + `KindergartenScopeGuard` + `StaffOnly`. Headers: `X-Device-Id` (required) — должен совпадать с `device_id` активного `refresh_tokens` row сканирующего staff (иначе 401 `no_active_session_for_device`; защищает rate-limit от подмены header'а). Body: `{token: string}` (32 hex). 1) Rate-limit check: 60/мин per `device_id` (Redis `rl:qr:scan:{device_id}` INCR+EXPIRE 60); 2) Redis lookup `qr:token:{plaintext}` → `user_id` (miss → DB-recheck); 3) DB load row → проверка `revoked_at IS NULL AND expires_at > NOW()` (DB is SoT — если cache hit но row revoked, всё равно 410 `qr_token_revoked`); 4) hydrate `user`; если parent — load `linkedChildren[]` (`{id, full_name, current_group_id, photo_url}`) из approved guardians **только из `kindergarten_id` сканирующего staff** — даже если у родителя есть approved-guardian связи в других садах, в ответе они не появляются; 5) Вычисление `allowed_actions`: parent → `['check_in','check_out']` при наличии approved guardian с `can_pickup=true` **в сканирующем kg** иначе `[]`; staff → `['gate_entry']`; super-admin → `[]`; 6) update `last_scanned_at`; 7) return `{user, linkedChildren?, allowedActions}` (`linkedChildren` только для role=parent — может быть `[]` если у родителя нет детей в сканирующем kg). Token идентичность cross-tenant (один QR для родителя с детьми в нескольких kg); список детей per-kg. Errors: 404 `qr_token_not_found`, 410 `qr_token_expired`, 410 `qr_token_revoked`, 429 `qr_rate_limit_exceeded`. |

### 3.6 Pickup OTP (Trusted Person)

<!-- B11 — in progress -->

**Guards:** `JwtAuthGuard` + `KindergartenScopeGuard` + `@Roles('mentor','admin')`. Все запросы kg-bound: tenant из JWT.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/pickup-requests` | Список `pickup_requests`. Query params: `groupId` (optional UUID), `status` (optional: `otp_sent\|validated\|expired\|cancelled`). Без фильтра возвращает все активные по kg. Response: `[{id, child_id, child_full_name, trusted_person_name, trusted_person_phone, status, expires_at, created_at}]`. **Privacy (B22a T8 / FINDINGS B11 H4):** `trusted_person_phone` is masked to `+7***LAST4` in this list response — full phone is only available via the single-get endpoint below. |
| GET | `/staff/pickup-requests/:id` | Детали + `trusted_person_name/phone/iin`, ребёнок (`child_id`, `child_full_name`, `current_group_id`), `status`, `validated_by`, `validated_at`, `attendance_event_id`. `trusted_person_phone` is the **full** E.164 number here (intentional — staff opening a single request need to call the trusted person). Errors: 404 `pickup_request_not_found`. (Note: `otp_ref` is intentionally not surfaced — it's an internal Redis cache key. Only `POST /staff/pickup-requests/:id/send-otp` returns it as auditable info for the calling staff.) |
| POST | `/staff/pickup-requests` | Создать pickup_request напрямую (trusted person пришёл без предварительной родительской заявки). Body: `{ child_id, trusted_person_id?, trusted_person_name?, trusted_person_phone?, trusted_person_iin? }`. Если `trusted_person_id` не null — snapshot полей копируется из `trusted_people` (проверяется `is_active=true` и `child_id` соответствие). Иначе — ad-hoc: `trusted_person_name` + `trusted_person_phone` обязательны. Создаёт `pickup_requests` со `status='otp_sent'`, `otp_ref='otp:pickup:{newId}'`, `expires_at=NOW()+1800s`. Response 201: `{id, status, trusted_person_phone, expires_at}`. Errors: 404 `trusted_person_not_found`, 403 `trusted_person_not_for_child`, 410 `trusted_person_revoked`. |
| POST | `/staff/pickup-requests/:id/send-otp` | Генерирует 6-digit код. Rate-limit check `rate:otp:{trusted_person_phone}` (shared с `/auth/otp/request`, 5/hour). Lockout-check `otp:locked:{phone}` → 429 `otp_locked`. Генерит код, пишет Redis `otp:pickup:{requestId}` Hash `{code, attempts:0}` TTL 1800с. `SmsPort.send(trusted_person_phone, pickupOtpTemplate(code, childName, kindergartenName))`. Dispatch `pickup.otp_sent` event (audit outbox). Errors: 404 `pickup_request_not_found`, 410 `pickup_request_expired`, 409 `pickup_request_already_validated`, 409 `pickup_request_status_invalid` (статус не `otp_sent`), 429 `otp_rate_limited`, 429 `otp_locked`. |
| POST | `/staff/pickup-requests/:id/validate-otp` | Сотрудник вводит код, продиктованный доверенным лицом. Advisory lock `pg_advisory_xact_lock(hashtext('pickup:validate:'||requestId))` — защита от concurrent validates. Читает `otp:pickup:{id}` (missing → 410 `otp_expired`); mismatch → `HINCRBY attempts`; при 3 — `SET otp:locked:{phone}` TTL 900с + DEL OTP key → 429 `otp_locked`. При совпадении: в одной TX — DEL OTP key, `pickup_requests.status='validated'`, `validated_by=staffMemberId`, `validated_at=NOW()`, вызывает `AttendanceService.checkOut(child_id, pickupRequestId, method='otp_pickup')` (создаёт `attendance_events` + `timeline_entries` + upsert `child_daily_status`), обновляет `pickup_requests.attendance_event_id`. Если `trusted_people.is_one_time=true` → `used_at=NOW()`, `is_active=false`. Dispatch `pickup.validated` event (recipients: approved guardians + requester). Response 200: `{pickup_request_id, attendance_event_id, validated_at}`. Errors: 404 `pickup_request_not_found`, 410 `pickup_request_expired`, 410 `trusted_person_revoked` (T7-5 HIGH#1: tp revoked between create and validate), 409 `pickup_request_already_validated`, 409 `pickup_request_status_invalid`, 410 `otp_expired`, 400 `invalid_otp`, 429 `otp_locked`. |
| POST | `/staff/pickup-requests/:id/cancel` | Отмена: `status='cancelled'`, DEL Redis `otp:pickup:{requestId}`. Response 200: `{id, status}`. Errors: 404 `pickup_request_not_found`, 409 `pickup_request_already_validated`, 409 `pickup_request_status_invalid`. |

**Request/response examples:**

```jsonc
// POST /staff/pickup-requests — ad-hoc (without whitelist)
// Request:
{ "child_id": "550e8400-e29b-41d4-a716-446655440001",
  "trusted_person_name": "Асем Нурова",
  "trusted_person_phone": "+77011234567" }
// Response 201:
{ "id": "550e8400-e29b-41d4-a716-446655440099",
  "status": "otp_sent",
  "trusted_person_phone": "+77011234567",
  "expires_at": "2026-05-02T12:30:00.000Z" }

// POST /staff/pickup-requests/:id/validate-otp
// Request:
{ "code": "482910" }
// Response 200:
{ "pickup_request": {
    "id": "550e8400-e29b-41d4-a716-446655440099",
    "kindergarten_id": "00000000-0000-0000-0000-000000000001",
    "child_id": "550e8400-e29b-41d4-a716-446655440001",
    "requested_by_user_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "trusted_person_id": "22222222-3333-4444-5555-666666666666",
    "trusted_person_name": "Асем Нурова",
    "trusted_person_phone": "+77011234567",
    "trusted_person_iin": null,
    "status": "validated",
    "validated_by": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    "validated_at": "2026-05-02T12:05:00.000Z",
    "attendance_event_id": "550e8400-e29b-41d4-a716-446655440200",
    "parent_request_id": null,
    "expires_at": "2026-05-02T12:30:00.000Z",
    "created_at": "2026-05-02T12:00:00.000Z"
  },
  "attendance_event_id": "550e8400-e29b-41d4-a716-446655440200" }
```

**Error map (B11 additions):**

| HTTP | `error` | Когда |
|---|---|---|
| 404 | `trusted_person_not_found` | `trusted_person_id` не найден в `trusted_people` |
| 403 | `trusted_person_not_for_child` | `trusted_people.child_id ≠ body.child_id` |
| 410 | `trusted_person_revoked` | `trusted_people.is_active=false` или `revoked_at IS NOT NULL` |
| 404 | `pickup_request_not_found` | Запись не найдена в kg |
| 410 | `pickup_request_expired` | `pickup_requests.status='expired'` или `expires_at < NOW()` |
| 409 | `pickup_request_already_validated` | `pickup_requests.status='validated'` |
| 409 | `pickup_request_status_invalid` | Неподходящий статус для операции (например, cancel при `validated`) |
| 410 | `otp_expired` | Ключ `otp:pickup:{requestId}` в Redis истёк или не существует |
| 400 | `invalid_otp` | Код не совпал (attempts < 3) |
| 429 | `otp_rate_limit` | `rate:otp:{phone}` превышен (5/hour) |
| 429 | `otp_locked` | `otp:locked:{phone}` активен (3 неверных попытки → 900с блокировка) |

### 3.7 Timeline & Intraday Status

**Display-overlays (B-N2):** `timeline_entry` несёт computed `recorded_by_full_name` (`recordedBy → staff_members.full_name ?? users.full_name`); `child_daily_status` несёт `set_by_full_name` (`setBy → …`). `null` при пустом источнике / не найдено / имя пустое. Резолв батчем (без N+1). Те же поля — в parent-проекциях (§4.3).

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/timeline-entries` | Создать запись: `child_id`, `entry_type` (activity/meal/nap/note/photo/mood/medication), `title`, `body`, `media_urls[]`, `metadata`, `entry_time`. Ответ несёт `recorded_by_full_name`. |
| PATCH | `/staff/timeline-entries/:id` | Редактировать (только автор или admin). |
| DELETE | `/staff/timeline-entries/:id` | Удалить. |
| GET | `/staff/timeline/child/:id` | Timeline ребёнка (пагинация). |
| POST | `/staff/daily-status` | Установить `child_daily_status` на дату: `child_id`, `date`, `status` (present/absent/sick/late/early_pickup/on_vacation), `note`. |

### 3.8 Activity Events (Schedule progression)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/activity-events/today` | Сегодняшние события моей группы. |
| GET | `/staff/activity-events/suggested-next` | Предлагаемое "Следующее событие" из шаблона расписания. |
| POST | `/staff/activity-events` | Создать событие: `group_id`, `activity_name`, `location_id`, `starts_at`, `ends_at`, `notes`. При создании — обновляется `groups.current_location_id` → WS broadcast `group:{id}:location_changed` (триггер перезапроса CCTV у родителей). Ответ-событие несёт computed `location_name` (`locationId → locations.name`; `null` при пустом / не найдено). |
| POST | `/staff/activity-events/:id/start` | `status='in_progress'`. Обновляет текущую локацию группы. |
| POST | `/staff/activity-events/:id/complete` | `status='completed'`. |
| POST | `/staff/activity-events/:id/cancel` | `status='cancelled'`. |
| GET | `/staff/schedule/week` | Расписание недели моей группы. |

### 3.9 Parent Requests (staff review)

**Auth:** `KindergartenScopeGuard` + `@Roles('mentor','specialist','admin')`. Role-filter: mentor видит заявки своей группы (day_off/vacation/late_pickup/trusted_person); specialist — `open_request` с `recipient_staff_id=me` или `recipient_type='specialist'`; admin — без ограничений (через admin API).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/parent-requests` | Заявки по моей роли (фильтр: `status`, `type`, `group_id`). **B22b T7 M16:** cursor-paged по `(created_at DESC, id DESC)`; `next_cursor` = base64-JSON `{createdAt,id}` или `null`. |
| GET | `/staff/parent-requests/:id` | Детали + messages. |
| POST | `/staff/parent-requests/:id/accept` | Принять: body `{review_note?}`. Conditional UPDATE WHERE status='pending'; 409 `parent_request_already_processed` при race. |
| POST | `/staff/parent-requests/:id/reject` | Отклонить: body `{review_note?}`. Conditional UPDATE WHERE status='pending'. |
| POST | `/staff/parent-requests/:id/messages` | Ответить в треде (staff-side message). Body: `{body, attachments?}`. |
| GET | `/staff/parent-requests/:id/messages` | Список messages (cursor-paged, `?cursor=`). |

### 3.10 Diagnostics (Specialist)

**Auth:** `KindergartenScopeGuard` + `@Roles('mentor','specialist','admin')`.

Templates create/update/deactivate — `/admin/diagnostic-templates` (admin role only, §2.19).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/diagnostic-templates` | Шаблоны (read-only). Query: `specialist_type` — staff defaults to caller's type; admin may pass `?all=true` to bypass. `is_active?` filter (default: all). Response: paginated list. |
| GET | `/staff/diagnostic-templates/:id` | Схема для заполнения. |
| GET | `/staff/diagnostic-entries` | Диагностики kg. Query: `child_id?: uuid`, `specialist_id?: uuid` (admin only — staff defaults to caller), `template_id?: uuid`, `from?: date`, `to?: date`, `cursor?`, `limit?` (default 20, max 100). Response: cursor-paged; каждая запись несёт `specialist_full_name` + `specialist_type` (display-overlay, см. `/staff/diagnostic-entries/:id`). |
| POST | `/staff/diagnostic-entries` | Создать. Body: `{child_id, template_id, assessment_date (date ≤ today), data (jsonb), summary?, recommendations?, attachments?: string[]}`. Response 201 full entry. |
| GET | `/staff/diagnostic-entries/:id` | Детали — включает computed `template_name`, `template_version`, `specialist_full_name` (display-overlay: `specialist_id → staff_members.full_name ?? users.full_name`; `null`, если staff-row отсутствует / имя пустое) и `specialist_type` (из `staff_members.specialist_type` ∈ {psychologist, speech_therapist, music_teacher, physical_ed, nutritionist}; `null`, если staff-row отсутствует / не специалист). |
| PATCH | `/staff/diagnostic-entries/:id` | Обновить. Body: subset of `{data, summary, recommendations, attachments}`. Author-only (`specialist_id` = caller's `staff_member_id`). Re-validates `data` against original `template.schema` if `data` provided. |
| GET | `/staff/my-todos` | Задачи specialist'а: дети, которым нужна новая диагностика. Query: `specialist_type?` (admin override; staff without specialist_type → 403). Algorithm: all active children in kg × latest entry where `template.specialist_type = caller.specialist_type` — child included if no prior entry OR `latest_assessment_date + 6 months < CURRENT_DATE` (Asia/Almaty). Response: `{children_needing_diagnostic: [{child_id, child_name, last_assessment_date?: date\|null, days_since_last: number\|null}]}`. |

**Error map (§3.10):**

| HTTP | code | Когда |
|---|---|---|
| 400 | `diagnostic_entry_data_invalid` | `data` не соответствует `template.schema`; body включает `details: {path, expected, actual}` |
| 404 | `not_found` | POST — `child_id` не найден или принадлежит другому kg (`ChildNotFoundError`); message: `child not found: <id>` |
| 404 | `diagnostic_template_not_found` | `template_id` не найден или вне kg |
| 409 | `diagnostic_template_inactive` | Шаблон деактивирован (`is_active=false`) |
| 400 | `assessment_date_in_future` | `assessment_date > CURRENT_DATE` |
| 403 | `diagnostic_entry_not_authored_by_you` | PATCH — caller не является автором записи |
| 403 | `staff_member_must_have_specialist_type` | `GET /staff/my-todos` — caller не имеет `specialist_type` и не передал `?specialist_type=` |
| 409 | `optimistic_lock_conflict` | PATCH — конкурентный writer изменил запись между read и write (B22a T4 row_version guard). Клиент должен перечитать запись и повторить. |

**Audit trail (B22a T7):** PATCH на `/staff/diagnostic-entries/:id` пишет `last_modified_by_user_id` (= caller `users.id`) + `last_modified_at` (= server clock) в DB. Колонки нужны для админ-override flow: admin прокидывает `entry.specialist_id` чтобы пройти author check, но `last_modified_by_user_id` фиксирует реальную идентичность редактора. Колонки внутренние, не возвращаются в HTTP-ответе в B22a (см. `docs/schema.dbml` §`diagnostic_entries`).

**422-vs-400 contract (B22b T5 — B18 Concern 2):**

Из-за того что `@IsNotEmpty()` / `@IsUUID()` / `@IsDateString()` на PATCH-DTO срабатывают в `ValidationPipe` ДО доменной логики, "пустое тело" и "не-UUID" PATCH-запросы возвращают **422** (`validation_error` от `class-validator`), а не 400 от доменного инварианта. Это намеренное поведение:

- **400 `<code>`** — структурно валидный body, но семантически отвергнут доменом: `diagnostic_entry_data_invalid` (schema mismatch с `details`), `assessment_date_in_future` (entity invariant). Эти ошибки имеют смысловой `error` code.
- **422 (class-validator)** — структурно невалидный body: не-UUID в `template_id`, не-ISO дата в `assessment_date`, пустые обязательные поля. Возвращается стандартный nest validation envelope: `{ statusCode: 422, message: [...details], error: 'Unprocessable Entity' }`. У этих ошибок НЕТ стабильного доменного `error` code — клиент должен парсить `message[]`.
- **409 `<code>`** — конфликт состояния: `diagnostic_template_inactive`, `optimistic_lock_conflict`.

Доменные инварианты типа `empty_body` существуют в коде но **недостижимы** через HTTP-pipeline для PATCH-эндпоинтов с DTO-валидацией: class-validator стрельнёт раньше. Это harmless asymmetry (всё равно 4xx + читаемое сообщение), но клиент-side обработчики должны учитывать оба формата ошибки. При появлении новых PATCH-эндпоинтов выбор простой: либо ослабить DTO-валидацию (чтобы доменный инвариант увидел запрос), либо принять 422-семантику class-validator'а как контракт (мы выбрали второе — меньше disruption).

### 3.11 Progress Notes (Mentor)

**Auth:** `KindergartenScopeGuard` + `@Roles('mentor','specialist','admin')`.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/progress-notes` | Заметки прогресса. Query: `child_id?: uuid`, `mentor_id?: uuid` (admin only — staff defaults to caller), `from?: date`, `to?: date`, `cursor?`, `limit?` (default 20, max 100). Response: cursor-paged. Каждая заметка несёт computed `mentor_full_name` (display-overlay: `mentor_id → staff_members.full_name ?? users.full_name`; `null`, если staff-row отсутствует / имя пустое). Также возвращается на POST/PATCH. |
| POST | `/staff/progress-notes` | Создать. Body: `{child_id, body (non-empty trimmed), media_urls?: string[], noted_at?: timestamptz (default now, ≤ now + 5 min skew)}`. Response 201 full note. |
| PATCH | `/staff/progress-notes/:id` | Обновить. Body: subset of `{body, media_urls}`. Author-only (`mentor_id` = caller's `staff_member_id`). |
| DELETE | `/staff/progress-notes/:id` | Удалить. Author OR admin role. |

**Error map (§3.11):**

| HTTP | code | Когда |
|---|---|---|
| 403 | `progress_note_not_authored_by_you` | PATCH/DELETE — caller не является автором (не admin) |
| 404 | `not_found` | POST — `child_id` не найден или принадлежит другому kg (`ChildNotFoundError`); message: `child not found: <id>` |
| 404 | `progress_note_not_found` | Заметка не найдена или вне kg |
| 409 | `optimistic_lock_conflict` | PATCH — конкурентный writer изменил заметку (B22a T4 row_version guard). |

**Audit trail (B22a T7):** PATCH на `/staff/progress-notes/:id` пишет `last_modified_by_user_id` + `last_modified_at` в DB (admin-override audit). Не возвращается в HTTP-ответе в B22a.

**422-vs-400 contract (B22b T5 — B18 Concern 2):** см. §3.10. То же правило применяется к PATCH `/staff/progress-notes/:id`: пустое тело / не-UUID `mentor_id` дают 422 (class-validator), а 400 `<code>` — для семантических доменных ошибок типа `body` non-empty trimmed invariant.

### 3.12 Group Stories (Mentor) — B17

**Auth:** `KindergartenScopeGuard` + `@Roles('mentor', 'admin')`.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/staff/stories` | Опубликовать story. `multipart/form-data`: `group_id` (uuid), `file` (image или video, обязателен), `caption?` (string). Файл загружается через `FileStoragePort`. Авто `expires_at = created_at + 24h`. Response 201: story object. Errors: 400 `file_upload_error`, 400 `media_type_invalid`, 404 `group_not_found`. |
| GET | `/staff/stories` | Активные stories (`expires_at > NOW()`). Mentor видит свои группы; admin — все группы kg. Response 200: `[{id, group_id, created_by, media_url, media_type, caption, views, expires_at, created_at}]`. |
| DELETE | `/staff/stories/:id` | Удалить story. Допустимо автору или admin. Вызывает `FileStoragePort.delete(media_url)`. Response 204. Errors: 404 `group_story_not_found`, 403 `access_denied`. |
| POST | `/staff/stories/:id/view` | Инкремент `group_stories.views`. Вызывается Parent App при просмотре. Не требует `mentor`-роли — доступен для parent (см. §4.9). Response 200: `{views: int}`. Errors: 404 `group_story_not_found`, 410 `group_story_expired`. |

**Story object:**

```json
{
  "id": "uuid",
  "kindergarten_id": "uuid",
  "group_id": "uuid",
  "created_by": "uuid",
  "media_url": "/static/kg-uuid/2026-06/file-uuid.jpg",
  "media_type": "image",
  "caption": "Утренняя зарядка",
  "views": 0,
  "expires_at": "2026-06-02T09:00:00.000Z",
  "created_at": "2026-06-01T09:00:00.000Z"
}
```

**Error map (§3.12):**

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `file_upload_error` | Ошибка записи файла через `FileStoragePort` |
| 400 | `media_type_invalid` | MIME не `image/*` / `video/*` |
| 403 | `access_denied` | Попытка DELETE чужой story не admin'ом |
| 404 | `group_not_found` | Группа не найдена в kg |
| 404 | `group_story_not_found` | Story не найдена |
| 410 | `group_story_expired` | Story просрочена (`expires_at <= NOW()`) |

### 3.13 Content (read-only)

**Auth:** `mentor`, `specialist`, or `reception` role.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/staff/schedule/week` | Расписание моей группы на неделю. Query: `week_start_date?` (default: текущая неделя). Response: `[{day_of_week, events: [{id, activity_name, starts_at, ends_at, status, location_id?, location_name?}]}]`. `location_name` — computed (`locationId → locations.name`), `null` при пустом / не найденном. |
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
| GET | `/parent/children/pending-requests` | **Перспектива заявителя** — мои `link`-заявки в статусе `pending_approval` (которые ждут подтверждения admin'ом или primary-родителем). Дополняет `/parent/approvals/pending` (та — перспектива primary, «кого Я подтверждаю»). Guards: `JwtAuthGuard` + `PendingRoleSelectGuard` (без `ChildAccessGuard` — у заявителя ещё нет approved-строки). Cross-tenant lookup `child_guardians WHERE user_id=self AND status='pending_approval'`. **PII ребёнка скрыт до approve** (как в `/link`): возвращается только **маскированное имя** (`Алия` → `А****`, по первой букве каждого слова), без ИИН/dob/фото/группы. Response: `[{id, role, can_pickup, status:'pending_approval', child_name_masked, kindergarten:{name}, created_at}]`. Новый repo-метод `findPendingByApplicantUserId(userId)`. |
| POST | `/parent/children/:id/unlink` | Отвязать (soft-revoke — `revoked_at`). |
| GET | `/parent/children/:id` | Карточка ребёнка: `{child: ChildDto, guardians: GuardianDto[]}`. `ChildDto` несёт display-overlays `current_group_name` (из `groups`) и `current_mentor_id` + `current_mentor_name` (активный ментор группы: `group_mentors WHERE unassigned_at IS NULL → staff_members.full_name ?? users.full_name`; `null`, если у группы нет активного ментора / staff-row отсутствует / имя пустое). `guardians` несут `user_full_name` + `user_phone` overlay. (Overlay строится только на этом эндпоинте; в списке `/parent/children` mentor/group-имена остаются `null` на unscoped multi-kg токене.) |
| GET | `/parent/children/:childId/kindergarten` | Садик, который посещает ребёнок — parent-safe проекция `{id, name, address, phone}` (без `settings`/`plan`/`slug`/lifecycle-флагов). Tenant из ресурса: `ChildAccessGuard` резолвит ребёнка cross-tenant и пинит его садик, поэтому работает и для multi-kg родителя (`kindergarten_id: null` в токене). Errors: 403 (не approved guardian этого ребёнка), 404 `kindergarten_not_found`. |

### 4.2 Approvals & Permissions (Primary Guardian)

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/approvals/pending` | Запросы на привязку к моим детям (я — primary). **Tenant из ресурса, не из токена:** садик выводится из детей, чьим primary я являюсь. kg-scoped JWT → внутри своего садика (RLS); unscoped JWT (multi-kg родитель, `kindergarten_id: null`) → cross-tenant фан-аут по всем садам (`findPendingForPrimaryCrossTenant`). token-kg больше не требуется. |
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
| GET | `/parent/children/:id/timeline` | Timeline ребёнка (пагинация по дате). Каждая запись несёт `recorded_by_full_name` (display-overlay). |
| GET | `/parent/children/:id/attendance` | История check-in/out. Каждое событие несёт `recorded_by_full_name` + `pickup_user_full_name` (display-overlay). |
| GET | `/parent/children/:id/daily-status` | Текущий статус (`present`/`absent`/`sick`/...) + события дня. `child_daily_status` несёт `set_by_full_name` (display-overlay). |

### 4.4 Invoices & Payments

**Три типа оплаты в MVP:**
1. **Monthly** — оплата текущего месяца (полная или частичная).
2. **Prepayment** — досрочная оплата на 3/6/12 месяцев (опционально 24 — если `discount_rules.prepay_24m_pct` задан админом). Создаётся отдельный invoice с `invoice_type='prepayment_{3|6|12|24}m'` и скидкой.
3. **Partial** — оплата меньшей суммы за текущий месяц. Использует тот же endpoint `/pay` с `amount < invoice.amount_after_discount`; статус инвойса становится `partial`, остаток остаётся.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/invoices` | Инвойсы ребёнка (фильтр: `status`, `invoice_type`, диапазон `due_date`). `ChildAccessGuard`: доступен для `primary`/`secondary`; 403 для `nanny`. |
| GET | `/parent/invoices/:id` | Детали + `invoice_line_items` + применённые `custom_discount_applications`. **Tenant из ресурса, не из токена:** `InvoiceAccessGuard` резолвит садик инвойса cross-tenant по `:id` и пинит `req.tenant`; сервис затем re-проверяет guardian-of-child в этом садике (`assertNonNannyGuardianForRead`), 403 для `nanny`/чужого. Работает с unscoped JWT; чужой садик → 403, несуществующий id → 404. |
| POST | `/parent/invoices/:id/pay` | Инициировать оплату текущего invoice. Body: `{provider: 'mock'\|'halyk_epay'\|'kaspi_pay'\|'tiptoppay'\|'freedom_pay', payment_mode: 'full'\|'partial', amount?: 60000, idempotency_key: 'uuid-v4-client-generated', kaspi_phone_number?: '7XXXXXXXXXX'}`. **`idempotency_key` обязателен** — UUID, клиент генерирует per-attempt; повторный запрос с тем же ключом возвращает тот же `payment_id` (200 без дублирующего платежа). При `partial` `amount` обязателен и должен быть < `invoice.amount_after_discount - sum(payments_completed)`. **`kaspi_phone_number` обязателен при `provider='kaspi_pay'`** (400 `kaspi_phone_required` иначе) — номер, на который Kaspi выставляет удалённый счёт (`remote/create`); для остальных провайдеров игнорируется. Создаёт `payments (status='initiated')`, возвращает `{payment_id, redirect_url?, deeplink?}`. **Для `kaspi_pay`** редиректа нет (оплата в приложении Kaspi у клиента) — возвращается `deeplink` (Kaspi `RecreateDeepLink`), `redirect_url=null`; завершение оплаты — через внутренний поллер (B24), НЕ через webhook. Требует подключённого `kaspi_merchant_session` (status=active) у садика — иначе 409 `kaspi_not_connected`. При `partial` после settlement статус инвойса становится `partial`; при полном покрытии — `paid`. **Tenant из ресурса:** `InvoiceAccessGuard` резолвит садик инвойса по `:id` (cross-tenant) и пинит `req.tenant`; `assertCanPay` проверяется в этом садике (работает с unscoped JWT; чужой садик → 403). Доступен для `primary`/`secondary`; 403 для `nanny`. Errors: 400 `payment_provider_mismatch` (`provider` ≠ активный deployment `PAYMENT_PROVIDER` — система single-global-provider, B13), 400 `kaspi_phone_required`, 404 `invoice_not_found`, 409 `invoice_already_paid`, 409 `kaspi_not_connected`, 409 `payment_idempotency_conflict` (тот же ключ, другой invoice_id), 429 rate-limit. |
| POST | `/parent/invoices/:id/pay/prepayment` | Досрочная оплата. Body: `{months: 3\|6\|12\|24, provider, idempotency_key}`. Сервер: находит активный `tariff_assignments` ребёнка, берёт `discount_rules.prepay_{N}m_pct` (если `prepay_24m_pct` отсутствует — 400 `{error: 'prepayment_horizon_not_configured'}`), создаёт новый invoice `invoice_type='prepayment_{N}m'` с правильным `amount_after_discount`, инициирует платёж. Ответ: `{invoice_id, payment_id, redirect_url, preview: {base_amount, discount_pct, final_amount, covers_period: {from, to}}}`. Доступен только `primary`. Errors: 400 `payment_provider_mismatch` (`provider` ≠ активный deployment `PAYMENT_PROVIDER`), 400 `prepayment_horizon_not_configured`. |
| GET | `/parent/children/:id/payment-calendar` | Календарь платежей в Kaspi-стиле. Параметры: `months_ahead=12` (1..24). Возвращает массив элементов на каждый месяц в окне: `{month: 'YYYY-MM', status: 'paid'\|'pending'\|'overdue'\|'partial'\|'projected', amount, invoice_id?, due_date, is_projection: bool, holidays_affected: int, prepayment_coverage?: {invoice_id, covers_through_month}}`. Для месяцев, где invoice уже создан (cron `billing:invoice-generate` или prepayment) — реальные данные. Для будущих месяцев — projection из активного `tariff_assignments` + `kindergarten_holidays` (pro-rata). Если месяц покрыт prepayment-invoice — `status='paid'`, `prepayment_coverage` указывает источник. Доступен для `primary`/`secondary`, **403 для `nanny`**. |
| GET | `/parent/payments` | Мои платежи (`payer_user_id=me`). Фильтр: `status`, `provider`, `child_id`, диапазон дат. |
| GET | `/parent/payments/:id` | Детали. |
| GET | `/parent/payments/:id/receipt` | Фискальный чек — возвращает `{qr_url, fiscal_sign, receipt_number, issued_at}` из `fiscal_receipts`. 404 если `status != 'issued'`. |

**Error map (§4.4):**

| HTTP | `error` | Когда |
|---|---|---|
| 403 | `access_denied` | Nanny обращается к `/pay`, `/payment-calendar`, `/invoices` (view_payments=false) |
| 404 | `invoice_not_found` | Инвойс не найден или не принадлежит ребёнку |
| 409 | `invoice_already_paid` | Попытка оплатить уже `paid` инвойс |
| 409 | `payment_idempotency_conflict` | `idempotency_key` уже использован для другого invoice_id |
| 400 | `prepayment_horizon_not_configured` | `months=24` но `discount_rules.prepay_24m_pct` не задан для тарифа |

### 4.5 Payment Webhooks (провайдеры — не parent-facing, но логически здесь)

**Auth:** без JWT-auth (`@Public()`). Верификация через `PaymentProviderPort.verifyWebhook(headers, body)`. **Cross-tenant:** webhook содержит `provider_txn_id`, сервис ищет `payments` по `(provider, provider_txn_id)` с `bypass_rls=true` per-event TX.

**Общий контракт:** верификация подписи провайдера → cross-tenant lookup payment → advisory lock per invoice → `PaymentProviderPort.verifyWebhook(headers, body)` → mark payment + `Invoice.applyPayment` → `FiscalReceiptPort.emitReceipt` → outbox events → **всегда 200** (идемпотентно; повторный webhook с уже обработанным `provider_txn_id` — no-op).

**Mock:** для `MockPaymentProvider` — `verifyWebhook` принимает header `x-mock-signature: 'valid'`; любой другой → `WebhookSignatureInvalidError` (400).

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/webhooks/payments/:provider` | Unified webhook endpoint. `provider` ∈ `mock\|halyk_epay\|kaspi_pay\|tiptoppay\|freedom_pay`. Body: провайдер-специфичный JSON payload. Headers: провайдер-специфичная подпись (например `x-mock-signature: 'valid'` для mock; `x-halyk-signature: 'hmac-sha256-...'` для halyk — реализуется в B14). Response: 200 всегда (кроме 400 `webhook_signature_invalid` при неверной подписи). |

**Предыдущие vendor-specific paths** (`/payments/webhook/halyk`, `/kaspi`, `/tiptoppay`, `/freedom-pay`) — задокументированы для будущих Phase B адаптеров; маршрутизируются через `/webhooks/payments/:provider` в B13+ или остаются как aliases в B14+.

> **⚠️ `kaspi_pay` НЕ использует webhooks (B24).** У Kaspi-клиента нет входящего callback'а. `verifyWebhook` для `provider=kaspi_pay` бросает `kaspi_webhook_unsupported`; завершение оплаты выполняет внутренний BullMQ-поллер `kaspi-payment-status` (cross-tenant, `remote/details` по `QrOperationId` → `Processed`→settle). См. §4.7 и IMPLEMENTATION_PLAN B24/K8.

**Error map (§4.5):**

| HTTP | `error` | Когда |
|---|---|---|
| 400 | `webhook_signature_invalid` | Подпись не прошла верификацию |
| 501 | `kaspi_webhook_unsupported` | Вызван webhook для `kaspi_pay` (завершение через поллер, не callback) |

### 4.6 Trusted People & Parent Pickup Requests

<!-- B11 — in progress -->

**Auth — tenant из ресурса, не из токена (Пакет C):** parent-токен по дизайну несёт `kindergarten_id: null` для multi-kg родителя (token-kg — лишь оптимизация-срез). `JwtAuthGuard` + `@Roles('parent')`, плюс per-route resource-guard, который пинит `req.tenant` на садик ресурса ДО основного кода (без этого все 5 роутов падали `400 tenant_required` на unscoped-токене):
- **`children/:id/*`** (`:id` = childId — GET/POST trusted-people, POST pickup-requests) → `ChildAccessGuard` резолвит ребёнка cross-tenant, допускает approved guardian и пинит садик ребёнка.
- **`trusted-people/:id`** (`:id` = trusted_person.id — PATCH, POST revoke) → `TrustedPersonAccessGuard` резолвит row cross-tenant по `:id` и пинит его садик; сервис проверяет ownership (автор ИЛИ approved-active guardian того же ребёнка) в резолвнутом садике (cross-tenant lookup резолвит садик ONLY, дыру не открывает).

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/trusted-people` | Whitelist доверенных для ребёнка. Возвращает `is_active=true` записи (активные + одноразовые, у которых ещё не `used_at`). Response: `[{id, full_name, phone, iin?, relation, photo_url?, is_one_time, is_active, used_at?, created_at, revoked_at?}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| POST | `/parent/children/:id/trusted-people` | Добавить доверенное лицо. Body: `{ full_name, phone, iin?, relation, photo_url?, is_one_time? }`. Валидация: `phone` E.164 strict; `iin` `/^\d{12}$/` если передан. Требует `trusted_people_manage` permission (locked — только primary). Response 201: `{id, full_name, phone, is_one_time, created_at}`. Errors: 403 `permission_denied` (`not_primary_guardian` или нет `trusted_people_manage`), 422 `invalid_phone_format`. |
| PATCH | `/parent/trusted-people/:id` | Обновить любые поля кроме `is_active` (для revoke — отдельный endpoint). Body: `{full_name?, phone?, iin?, relation?, photo_url?, is_one_time?}`. Только автор (`added_by_user_id = req.user.user_id`) или primary guardian того же ребёнка. Errors: 404 `trusted_person_not_found`, 403 `trusted_person_not_for_child`, 410 `trusted_person_revoked`. |
| POST | `/parent/trusted-people/:id/revoke` | Отозвать: `revoked_at=NOW()`, `is_active=false`. Если есть открытые `pickup_requests` с этим `trusted_person_id` и `status='otp_sent'` — они не отменяются автоматически (staff cancel вручную). Response 200: `{id, revoked_at}`. Errors: 404 `trusted_person_not_found`, 403 `trusted_person_not_for_child`, 410 `trusted_person_revoked` (уже отозван). |
| POST | `/parent/children/:id/pickup-requests` | Родитель инициирует pickup-request заранее. Body: `{ trusted_person_id }` (из whitelist) или ad-hoc `{ trusted_person_name, trusted_person_phone, trusted_person_iin? }`. Если `trusted_person_id` — snapshot копируется; `is_active=true` обязателен. Создаёт `pickup_requests` со `status='otp_sent'`. OTP **не отправляется** при создании — staff явно вызовет `send-otp` при появлении доверенного лица. Response 201: `{id, child_id, trusted_person_name, trusted_person_phone, status, expires_at}`. Errors: 404 `child_not_found`, 403 `access_denied`, 404 `trusted_person_not_found`, 403 `trusted_person_not_for_child`, 410 `trusted_person_revoked`, 422 `invalid_phone_format`. |

**Request/response examples:**

```jsonc
// POST /parent/children/:id/trusted-people
// Request:
{ "full_name": "Асем Нурова", "phone": "+77011234567",
  "iin": "890512300124", "relation": "тётя", "is_one_time": false }
// Response 201:
{ "id": "550e8400-e29b-41d4-a716-446655440010",
  "full_name": "Асем Нурова", "phone": "+77011234567",
  "is_one_time": false, "created_at": "2026-05-02T10:00:00.000Z" }

// POST /parent/children/:id/pickup-requests — by whitelist
// Request:
{ "trusted_person_id": "550e8400-e29b-41d4-a716-446655440010" }
// Response 201:
{ "id": "550e8400-e29b-41d4-a716-446655440099",
  "child_id": "550e8400-e29b-41d4-a716-446655440001",
  "trusted_person_name": "Асем Нурова",
  "trusted_person_phone": "+77011234567",
  "status": "otp_sent",
  "expires_at": "2026-05-02T10:30:00.000Z" }
```

**Error map (B11 — parent side):** те же `trusted_person_not_found`, `trusted_person_revoked`, `trusted_person_not_for_child` что и §3.6, плюс стандартные 401/403 по `ChildAccessGuard`.

### 4.7 Parent Requests

**Auth — tenant из ресурса, не из токена** (parent-токен по дизайну несёт `kindergarten_id: null` для multi-kg родителя; token-kg — лишь оптимизация-срез, не источник истины): `JwtAuthGuard` + `@Roles('parent')`, плюс per-route resource-guard:
- **CREATE** (`otp-request`, `trusted-person`, `day-off`, `vacation`, `late-pickup`, `open`; `child_id` в body) → `ChildBodyAccessGuard` резолвит ребёнка cross-tenant по `child_id`, допускает approved guardian и пинит `req.tenant` на садик ребёнка; сервис затем проверяет `create_requests`-permission в этом садике.
- **`:id`** (`GET /:id`, `:id/cancel`, `:id/messages` POST+GET) → `ParentRequestAccessGuard` резолвит заявку cross-tenant по `:id` и пинит `req.tenant` на садик заявки; сервис проверяет requester-ownership. Чужая заявка → 403, несуществующая → 404.
- **`list`** (`GET /parent/requests`) → kg-scoped fast-path при наличии kg в токене, иначе cross-tenant фан-аут по своим заявкам во всех садах (`listForRequesterCrossTenant`).

Wire-keys — snake_case (`child_id`, `weekend_dates`, `expected_time`, `is_one_time`, `create_pickup_request`, `recipient_type`, `recipient_staff_id`, `review_note`).

**Display-overlays (B-N2):** заявка несёт `recipient_staff_full_name` + `reviewed_by_full_name`; каждое message несёт `author_full_name` (см. §2.18). `null` при пустом источнике / не найдено / имя пустое.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/requests` | Мои заявки (фильтр: `status`, `type`, `child_id`). **B22b T7 M16:** cursor-paged по `(created_at DESC, id DESC)`; `next_cursor` = base64-JSON `{createdAt,id}` или `null`. Каждая заявка несёт `recipient_staff_full_name` + `reviewed_by_full_name`. |
| GET | `/parent/requests/:id` | Детали + messages (`author_full_name` на каждом message). |
| POST | `/parent/requests/otp-request` | Запрос OTP для trusted_person заявки. Body: `{child_id}`. Rate-limit `rate:otp:{phone}` (5/hour, shared с auth). Redis `otp:request:trusted-person:{userId}` TTL 1800с. SMS уходит на **собственный** зарегистрированный телефон запрашивающего родителя (`users.phone`, re-auth — подтверждает, что заявку подаёт сам родитель), **не** на телефон доверенного лица. |
| POST | `/parent/requests/trusted-person` | Заявка на доверенное лицо — **одностадийно** (код + заявка в одной TX). Body (snake_case): `{code, child_id, full_name, phone, iin?, relation, photo_url?, is_one_time?, create_pickup_request?}`. Валидирует OTP в ambient TX; создаёт заявку `trusted_person`. Если `create_pickup_request=true` — также создаёт `pickup_requests` row атомарно с `parent_request_id` FK. При **accept** админом доверенному лицу уходит best-effort SMS-уведомление о назначении (на его `phone`). Доступен только `primary`. |
| POST | `/parent/requests/day-off` | Заявка на выходные — ребёнок **ОСТАЁТСЯ В САДУ**. Body: `{child_id, weekend_dates: ["YYYY-MM-DD", ...], comment?}`. 1-2 даты, каждая суббота или воскресенье; обе в одной календарной неделе. |
| POST | `/parent/requests/vacation` | Заявка на отпуск — ребёнок **НЕ ХОДИТ В САД**. Body: `{child_id, date_from, date_to, comment?}`. `date_from ≤ date_to`, `date_from ≥ today`. |
| POST | `/parent/requests/late-pickup` | Заявка на поздний забор. Body: `{child_id, date, expected_time, comment?}`. `expected_time` = HH:MM. При `accept` (B13) — генерируется `late_pickup_fee` invoice и `parent_requests.invoice_id` проставляется FK. |
| POST | `/parent/requests/open` | Открытая заявка. Body: `{child_id, recipient_type, recipient_staff_id?, subject, message, attachments?}`. `recipient_type`: `'admin' \| 'mentor' \| 'specialist'`. |
| POST | `/parent/requests/:id/cancel` | Отмена заявки. Только `status='pending'`. Conditional UPDATE WHERE status='pending'; 409 `parent_request_already_processed` при race. |
| POST | `/parent/requests/:id/messages` | Добавить parent message в тред. Body: `{body, attachments?}`. |
| GET | `/parent/requests/:id/messages` | Список messages (cursor-paged, `?cursor=`). |

**Error map (B12):**

| HTTP | `error` | Когда |
|---|---|---|
| 404 | `parent_request_not_found` | Заявка не найдена в kg |
| 409 | `parent_request_already_processed` | Race на conditional UPDATE (ещё один переход уже выполнен) |
| 409 | `parent_request_status_invalid` | Попытка cancel из не-pending состояния |
| 403 | `parent_request_forbidden` | Parent тычется в чужую заявку |
| 403 | `create_request_permission_required` | `guardian.permissions.create_requests=false` |
| 400 | `invalid_otp` | Код не совпал (attempts < 3) |
| 410 | `otp_expired` | OTP TTL истёк или ключ не существует |
| 429 | `otp_rate_limit` | `rate:otp:{phone}` превышен (5/hour) |
| 429 | `otp_locked` | 3 неверных попытки → 900с блокировка |

### 4.8 CCTV

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/cctv/access` | Определяет камеры: `child.current_group_id → groups.current_location_id → cameras WHERE location_id=? AND is_active`. Генерит Redis `cctv:token:{user_id}:{camera_id}` TTL 3600с. Возвращает `[{camera_id, name, stream_url: "https://stream.shyraq.kz/live/{cam}/index.m3u8?token=xxx"}]`. Клиенту рекомендуется подписаться на WS-комнату `group:{group_id}:location_changed` и при получении события `location_changed` перезапросить этот endpoint. Доступен для `primary`/`secondary`; **403 для `nanny`**. |
| GET | `/cctv/validate` | Внутренний endpoint для Nginx `auth_request`. Читает `cctv:token:{user_id}:{camera_id}`, сравнивает с `?token=`. Возвращает 200/403. Не вызывается клиентами. |

### 4.9 Content Feed — B17

**Auth:** `ChildAccessGuard` + `@Roles('parent')`. JWT-аутентификация; tenant резолвится из ребёнка.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/content` | Агрегированная лента для ребёнка: `news` + `qundylyq` + `birthday` (targeted `all`/`group`/`child`) + `menu` + `schedule_pub` — только `status='published'`. Cursor-пагинация. Query: `cursor?`, `limit?` (default 20). Локализовано по `users.locale`. Response: `[{id, content_type, title_i18n, body_i18n, media_urls, metadata, published_at, target_type}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| GET | `/parent/children/:id/stories` | Активные stories группы ребёнка (`expires_at > NOW()`). Response: `[{id, group_id, media_url, media_type, caption, views, expires_at, created_at}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| POST | `/staff/stories/:id/view` | Инкремент `group_stories.views`. Доступен родителям; вызывается автоматически при просмотре story в Parent App. Response 200: `{views: int}`. Errors: 404 `group_story_not_found`, 410 `group_story_expired`. |
| GET | `/parent/feed` | Устаревший endpoint (сохранён для обратной совместимости). Лента: news, qundylyq, birthdays, targeted posts (all / group / child). Локализовано по `users.locale`. Предпочтительный path — `GET /parent/children/:id/content`. |
| GET | `/parent/content/news` | Только новости садика (все kg ребёнка). |
| GET | `/parent/content/qundylyq/current` | Текущий Qundylyq (тема месяца, `status='published'`, последний по `published_at`). |
| GET | `/parent/children/:id/menu` | Меню на период. Query: `date_from`, `date_to` (ISO date, обязательны). Возвращает `meal_plans` группы ребёнка (приоритет) или общего садика за период с вложенными `meal_items`. Response: `[{date, items: [{meal_type, dish_name: {ru,kz}, description?, allergens?, calories?, photo_url?}]}]`. Errors: 404 `child_not_found`, 403 `access_denied`. |
| GET | `/parent/children/:id/schedule` | Расписание группы ребёнка. Query: `date_from`, `date_to` (ISO date, обязательны). Возвращает `activity_events` группы за период. Response: `[{id, activity_name, starts_at, ends_at, status, location_id?, location_name?, notes?}]`. `location_name` — computed display-overlay (`locationId → locations.name`), `null` при пустом / не найденном. Errors: 404 `child_not_found`, 403 `access_denied`. |

**Error map (§4.9):**

| HTTP | `error` | Когда |
|---|---|---|
| 403 | `access_denied` | Guardian не approved/активен или `revoked_at` не null |
| 404 | `child_not_found` | Ребёнок не найден или нет guardian-связи |
| 410 | `group_story_expired` | Story просрочена при попытке `view` |

### 4.10 Diagnostics & Progress (read)

**Gate:** `view_diagnostics` permission (§4.13). Nanny → 403 `nanny_no_diagnostics_access` на всех трёх эндпоинтах.

Архивированные (деактивированные) шаблоны НЕ блокируют видимость прошлых записей, созданных по этим шаблонам — родитель видит все исторические записи.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/parent/children/:id/diagnostics` | Диагностики ребёнка (все специалисты). Query: `cursor?`, `limit?` (default 20, max 100), `from?: date`, `to?: date`. Пагинация по `assessment_date DESC`. Каждая запись несёт `specialist_full_name` + `specialist_type` (см. `/parent/children/:id/diagnostics/:entryId`). |
| GET | `/parent/children/:id/diagnostics/:entryId` | Детали: `data`, `summary`, `recommendations`, `attachments`, `template_name`, `template_version`, `specialist_full_name` (display-overlay: `specialist_id → staff_members.full_name ?? users.full_name`; `null`, если staff-row отсутствует / имя пустое), `specialist_type` (из `staff_members.specialist_type` ∈ {psychologist, speech_therapist, music_teacher, physical_ed, nutritionist}; `null`, если staff-row отсутствует / не специалист). Errors: 404 `diagnostic_entry_not_found`. |
| GET | `/parent/children/:id/progress-notes` | Заметки прогресса от mentor. Query: `cursor?`, `limit?` (default 20, max 100), `from?: date`, `to?: date`. Пагинация по `noted_at DESC`. Каждая заметка несёт `mentor_full_name` (display-overlay: `mentor_id → staff_members.full_name ?? users.full_name`; `null`, если staff-row отсутствует / имя пустое). |

**Parent DTO contract (B22b T5 — B18 L3):** parent-side эндпоинты используют **dedicated query DTO** (`ParentListDiagnosticEntriesQueryDto`, `ParentListProgressNotesQueryDto`) которые принимают только `from?`, `to?`, `cursor?`, `limit?`. Staff-only фильтры (`child_id` — уже в URL, `specialist_id`, `template_id`, `mentor_id`) НЕ exposed в parent-Swagger — `whitelist: true` глобального `ValidationPipe` отбрасывает посторонние ключи. Это страхует от тривиального enumeration over staff ids и подгоняет OpenAPI-контракт под реальное поведение handler'а.

**Error map (§4.10):**

| HTTP | code | Когда |
|---|---|---|
| 403 | `nanny_no_diagnostics_access` | Guardian role = nanny |
| 404 | `diagnostic_entry_not_found` | `entryId` не найден или вне доступного scope ребёнка |

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
| `view_diagnostics` | ✅ | ✅ | ❌ | — | GET diagnostics, progress-notes. Включает progress_notes (единая permission). |
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
- **QR ручной refresh в UI** — кнопка "Обновить" у пользователя, если придёт запрос (сейчас только автоматический серверный refresh на GET).
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
