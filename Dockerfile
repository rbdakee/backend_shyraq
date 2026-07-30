FROM node:24.14.1-alpine

RUN apk add --no-cache bash

WORKDIR /usr/src/app

# Dependencies layer — cached until package*.json changes. Installed straight
# into the workdir so we never duplicate node_modules with a `cp -a` (the old
# /tmp/app + cp pattern copied ~1GB of deps per image and dominated build time
# on the small dev box). node_modules is .dockerignore'd, so the later
# `COPY . .` cannot clobber it.
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Boot scripts live under /opt (referenced by CMD). Strip CRLF in case they
# were checked out with Windows line endings.
COPY ./wait-for-it.sh /opt/wait-for-it.sh
COPY ./startup.relational.dev.sh /opt/startup.relational.dev.sh
RUN chmod +x /opt/wait-for-it.sh /opt/startup.relational.dev.sh \
 && sed -i 's/\r//g' /opt/wait-for-it.sh /opt/startup.relational.dev.sh

# NOTE: do NOT seed a .env into the image. `.env`/`.env.*` are .dockerignore'd,
# so the old `cp env-example-relational .env` guard was always true and baked
# the EXAMPLE defaults into every layer. `ConfigModule` loads `envFilePath:
# ['.env']` at runtime, so any variable the compose `env_file` did not set was
# silently filled from that example — which is how a production image ran with
# PAYMENT_PROVIDERS=mock while the real env carried the singular
# PAYMENT_PROVIDER=kaspi (the registry's singular fallback would have caught it
# had the plural not been pre-filled). Parent payments failed with
# payment_provider_unavailable until it was patched on the server.
# The build itself needs no env: `nest build -b swc` reads none.
RUN npm run build:swc

CMD ["/opt/startup.relational.dev.sh"]
