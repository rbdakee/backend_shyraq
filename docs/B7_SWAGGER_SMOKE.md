# B7 Swagger Smoke Checklist — Schedule, Meal & Weekly Rollout

Manual spot-check list for Swagger UI at `GET /docs`. Verify each item in the browser or via `curl`.

## 1. Admin / Schedule — Templates

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 1 | GET    | `/api/v1/admin/schedule/templates` | 200 array, requires Bearer | [ ] |
| 2 | POST   | `/api/v1/admin/schedule/templates` | 201 `ScheduleTemplateResponseDto` (id, name, groupId, slots[], validFrom) | [ ] |
| 3 | GET    | `/api/v1/admin/schedule/templates/:id` | 200 template+slots / 404 `schedule_template_not_found` | [ ] |
| 4 | PATCH  | `/api/v1/admin/schedule/templates/:id` | 200 updated template | [ ] |
| 5 | DELETE | `/api/v1/admin/schedule/templates/:id` | 204 / 404 `schedule_template_not_found` | [ ] |

## 2. Admin / Schedule — Slots

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 6 | POST   | `/api/v1/admin/schedule/templates/:id/slots` | 201 full template (with new slot). 409 `slot_time_conflict` on duplicate dayOfWeek+startTime. 400/422 when startTime >= endTime | [ ] |
| 7 | PATCH  | `/api/v1/admin/schedule/templates/:id/slots/:slotId` | 200 updated template | [ ] |
| 8 | DELETE | `/api/v1/admin/schedule/templates/:id/slots/:slotId` | 204 | [ ] |

## 3. Admin / Schedule — Activity Events

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 9  | GET    | `/api/v1/admin/schedule/activity-events` | 200 array, supports `groupId`, `from`, `to`, `status` query params | [ ] |
| 10 | POST   | `/api/v1/admin/schedule/activity-events` | 201 `ActivityEventResponseDto` (id, groupId, activityName, status=scheduled, startsAt) | [ ] |
| 11 | PATCH  | `/api/v1/admin/schedule/activity-events/:id` | 200 / 409 `invalid_activity_event_transition` if not scheduled | [ ] |
| 12 | DELETE | `/api/v1/admin/schedule/activity-events/:id` | 204 / 409 `activity_event_not_deletable` if in_progress/completed/cancelled | [ ] |

## 4. Staff / Schedule — State Machine

| # | Method | Path | Roles | Expected | Check |
|---|--------|------|-------|----------|-------|
| 13 | POST | `/api/v1/staff/schedule/activity-events/:id/start`    | mentor, specialist, reception | 200 status=in_progress / 409 `invalid_activity_event_transition` | [ ] |
| 14 | POST | `/api/v1/staff/schedule/activity-events/:id/complete` | mentor, specialist, reception | 200 status=completed / 409 | [ ] |
| 15 | POST | `/api/v1/staff/schedule/activity-events/:id/cancel`   | mentor, specialist, reception | 200 status=cancelled (body: `{reason}`) / 409 | [ ] |
| 16 | GET  | `/api/v1/staff/schedule/today?groupId=<uuid>`         | mentor, specialist, reception | 200 `ActivityEventResponseDto[]` | [ ] |
| 17 | GET  | `/api/v1/staff/schedule/week?groupId=<uuid>&weekStart=YYYY-MM-DD` | mentor, specialist, reception | 200 `ScheduleWeekResponseDto` (weekStart, days[]) | [ ] |

## 5. Parent / Schedule — ChildAccessGuard

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 18 | GET | `/api/v1/parent/children/:childId/schedule?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` | 200 `ActivityEventResponseDto[]` (approved guardian) / 403 (non-guardian) / 200 empty array if child has no group | [ ] |

## 6. Admin / Schedule — Week Snapshots

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 19 | GET  | `/api/v1/admin/schedule/week-snapshots` | 200 `ScheduleWeekSnapshotResponseDto[]`, supports `groupId`, `from`, `to` | [ ] |
| 20 | POST | `/api/v1/admin/schedule/week-snapshots/copy` | 200 `WeekCopySummaryDto` {copiedGroups, skippedGroups, totalEvents}. Body: `{fromMonday: "YYYY-MM-DD"}`. Idempotent: second call same fromMonday → copiedGroups=0, skippedGroups>0 | [ ] |

## 7. Admin / Meal Plans — CRUD

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 21 | GET    | `/api/v1/admin/meal-plans` | 200 `MealPlanResponseDto[]`, supports `date_from`, `date_to`, `group_id` | [ ] |
| 22 | POST   | `/api/v1/admin/meal-plans` | 201 `MealPlanResponseDto` (id, date, group_id, is_published, items[]). 409 `meal_plan_already_exists` on duplicate (kg+group+date or kg+date for kg-wide) | [ ] |
| 23 | GET    | `/api/v1/admin/meal-plans/:id` | 200 plan with items / 404 `meal_plan_not_found` | [ ] |
| 24 | PATCH  | `/api/v1/admin/meal-plans/:id` | 200 updated plan | [ ] |
| 25 | DELETE | `/api/v1/admin/meal-plans/:id` | 204, items CASCADE / 404 `meal_plan_not_found` | [ ] |

## 8. Admin / Meal Plans — Items

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 26 | POST   | `/api/v1/admin/meal-plans/:id/items` | 201 `MealPlanResponseDto` (returns full plan). Body: `{meal_type, dish_name: {ru}}` | [ ] |
| 27 | PATCH  | `/api/v1/admin/meal-plans/:id/items/:itemId` | 200 full plan / 404 `meal_item_not_found` | [ ] |
| 28 | DELETE | `/api/v1/admin/meal-plans/:id/items/:itemId` | 204 / 404 | [ ] |

## 9. Admin / Meal Plans — Copy Week

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 29 | POST | `/api/v1/admin/meal-plans/copy-week` | 200 `CopyWeekSummaryDto` {plans_created, plans_skipped}. Body: `{source_week_start_date: "YYYY-MM-DD"}`. NOTE: idempotent re-run currently returns 500 (known bug — T7) | [ ] |

## 10. Parent / Children Menu — ChildAccessGuard

| # | Method | Path | Expected | Check |
|---|--------|------|----------|-------|
| 30 | GET | `/api/v1/parent/children/:childId/menu?week_start=YYYY-MM-DD` | 200 `MealMenuWeekResponseDto` {week_start, days[]} — only `is_published=true` plans visible. 403 if not approved guardian | [ ] |

## 11. Admin / Weekly Rollout (super_admin only)

| # | Method | Path | Scope | Expected | Check |
|---|--------|------|-------|----------|-------|
| 31 | POST | `/api/v1/admin/schedule/week-rollout/run` | super_admin | 200 `RolloutSummaryResponseDto` {fromMonday, source, kindergartens[], totals}. Optional body `{fromMonday: "YYYY-MM-DD"}`. 403 for admin role | [ ] |

## 12. Auth / Error-Code Spot-Check

Verify the `error` field (DomainErrorFilter code) is present and stable in these response bodies:

| Scenario | Status | Expected `error` field |
|----------|--------|------------------------|
| GET template that doesn't exist | 404 | `schedule_template_not_found` |
| POST slot with conflicting time | 409 | `slot_time_conflict` |
| Start an already-completed event | 409 | `invalid_activity_event_transition` |
| DELETE in-progress event | 409 | `activity_event_not_deletable` |
| POST duplicate meal plan (same group+date) | 409 | `meal_plan_already_exists` |
| GET meal plan not found | 404 | `meal_plan_not_found` |
| GET child schedule as non-guardian parent | 403 | `child_access_denied` |
| POST week-rollout/run as admin (not super_admin) | 403 | (RolesGuard standard 403) |

## 13. Cron / Automated Endpoints (not in Swagger — verify via logs)

| Cron | Description |
|------|-------------|
| `schedule:auto-copy` | Weekly schedule copy — equivalent to `POST /admin/schedule/week-snapshots/copy` |
| `schedule:weekly-rollout` | Full cross-kg rollout — equivalent to `POST /admin/schedule/week-rollout/run` |

These crons are NOT exposed in Swagger but must be exercised by `npm run test:e2e` through the manual trigger endpoints.

## 14. DTO Completeness Check (Swagger UI)

Open `/docs` and verify:
- `ScheduleTemplateResponseDto`: id, kindergartenId, groupId, name, recurrence, isActive, validFrom, validUntil, slots[], createdAt
- `ActivityEventResponseDto`: id, kindergartenId, groupId, templateSlotId (nullable), activityName, locationId (nullable), startsAt, endsAt (nullable), status (enum), createdBy (nullable), notes (nullable), createdAt, updatedAt
- `MealPlanResponseDto`: id, date, group_id (nullable), is_published, notes (nullable), source, copied_from (nullable), items[], created_at, updated_at
- `MealItemResponseDto`: id, meal_type (enum), dish_name (object), description (nullable), allergens (nullable), photo_url (nullable), calories (nullable), position
- `WeekCopySummaryDto`: copiedGroups, skippedGroups, totalEvents
- `CopyWeekSummaryDto`: plans_created, plans_skipped
- `RolloutSummaryResponseDto`: fromMonday, source, kindergartens[], totals{kindergartens, copiedGroups, skippedGroups, totalEvents, plansCreated, plansSkipped, errors}
- All `@ApiProperty` fields have realistic `example` values

## 15. Authorization Matrix

| Endpoint prefix | admin | mentor/specialist/reception | parent | super_admin |
|-----------------|-------|-----------------------------|--------|-------------|
| `/admin/schedule/*` | allowed | 403 | 403 | 403 |
| `/admin/meal-plans/*` | allowed | 403 | 403 | 403 |
| `/staff/schedule/*` | 403 | allowed | 403 | 403 |
| `/parent/children/:childId/schedule` | 403 | 403 | allowed (guardian only) | 403 |
| `/parent/children/:childId/menu` | 403 | 403 | allowed (guardian only) | 403 |
| `/admin/schedule/week-rollout/run` | 403 | 403 | 403 | allowed |
