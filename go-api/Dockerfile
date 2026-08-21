# Stage 1 — builder
FROM golang:1.26-alpine AS builder

WORKDIR /src

# Layer cache: deps first
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build the real binaries; CGO disabled for a fully static output.
# bgmbackfill is the one-shot enrichment re-validation/backfill ops tool,
# invoked via the docker-compose `backfill` service (profile: tools).
# hantbackfill is the zh-Hant title/synopsis backfill, invoked via the
# `hantbackfill` service in the same profile.
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server       ./cmd/server && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/bgmbackfill  ./cmd/bgmbackfill && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/hantbackfill ./cmd/hantbackfill

# Stage 2 — runtime
FROM alpine:3.20

RUN apk add --no-cache ca-certificates wget tzdata && \
    adduser -D -u 1000 app && \
    mkdir -p /data/avatars && chown -R app:app /data

COPY --from=builder /out/ /usr/local/bin/

# hantbackfill reads its datasets from disk rather than embedding them:
# data/hant carries a CC BY-SA dataset, and go:embed would pull it into an
# AGPL package and erase the licence boundary data/hant/README.md draws.
# ~1.7 MB, and only this one tool reads it.
COPY --from=builder /src/data/hant/ /usr/local/share/animego/hant/

USER app
WORKDIR /home/app

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["server"]
