#!/usr/bin/env bash
set -e

/opt/wait-for-it.sh postgres:5432
/opt/wait-for-it.sh redis:6379
npm run migration:run

# Static gate — fail fast before booting anything.
npm run lint

# Unit suite — pure, no infra. Cheap upfront check so an obvious break
# doesn't burn the integration+e2e budget.
npm test -- --runInBand

# Integration suite — hits the same PG+Redis the e2e will use. Verifies
# RLS / tenant isolation / repository wiring against the real driver.
INTEGRATION_DB=1 npm test -- --testPathPatterns=integration --runInBand

# E2E — full HTTP stack against the booted app.
npm run start:prod > prod.log 2>&1 &
/opt/wait-for-it.sh maildev:1080
/opt/wait-for-it.sh localhost:3000
npm run test:e2e -- --runInBand
