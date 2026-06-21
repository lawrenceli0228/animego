# go-api/docker/postgres/Dockerfile
# Postgres 16 + pg_cron extension compiled from source.
# postgres:16-alpine does not bundle pg_cron; this image adds it so the
# danmaku TTL job (and any future scheduled SQL) can run inside the DB
# without an external cron-like sidecar.

FROM postgres:16-alpine

ARG PG_CRON_VERSION=1.6.5

# Build deps installed transiently — removed at end of layer to keep the
# image lean (final image ~225 MB, mostly the pg_cron .so + headers churn).
#
# NB: we deliberately do NOT pull clang/llvm. Those were pinned (clang19 /
# llvm19-dev) only to let PGXS emit JIT bitcode (*.bc) for the extension, and
# the pin rotted the moment `postgres:16-alpine` floated onto a newer Alpine
# (3.24 ships clang16/18/22, llvm15..22 — no 19), so `apk add` failed with
# "unable to select packages" and broke BOTH the CI postgres-image build and
# the prod deploy build. Bitcode is a pure optimization: the .so loads and
# pg_cron schedules run identically without it, so we build `with_llvm=no`
# and drop the toolchain entirely. What's left (build-base + postgresql16-dev)
# tracks the base image's major version and does not pin a disappearing minor.
RUN apk add --no-cache --virtual .build-deps \
        build-base \
        postgresql16-dev \
        git \
        ca-certificates \
 && cd /tmp \
 && git clone --depth=1 --branch v${PG_CRON_VERSION} https://github.com/citusdata/pg_cron.git \
 && cd pg_cron \
 && make with_llvm=no \
 && make with_llvm=no install \
 && cd / && rm -rf /tmp/pg_cron \
 && apk del .build-deps

# pg_cron must be loaded via shared_preload_libraries.  Patching the
# postgresql.conf.sample so that initdb on a fresh data dir picks these up
# automatically, no docker compose command override needed.
#
# cron.database_name = the DB where pg_cron stores its job table + runs
# scheduled commands.  Aligned with docker-compose POSTGRES_DB and the
# testcontainers WithDatabase("animego") setting.
RUN echo "shared_preload_libraries = 'pg_cron'" >> /usr/local/share/postgresql/postgresql.conf.sample \
 && echo "cron.database_name = 'animego'" >> /usr/local/share/postgresql/postgresql.conf.sample

# Health check via pg_isready works the same as the stock image.
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
    CMD pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" || exit 1
