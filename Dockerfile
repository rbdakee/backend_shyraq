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

RUN if [ ! -f .env ]; then cp env-example-relational .env; fi
RUN npm run build:swc

CMD ["/opt/startup.relational.dev.sh"]
