# Stage 1 — builder
FROM golang:1.26-alpine AS builder

WORKDIR /src

# Layer cache: deps first
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build all three real binaries; CGO disabled for a fully static output
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/server        ./cmd/server      && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/migrate-mongo ./cmd/migrate-mongo && \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/parity-check  ./cmd/parity-check

# Stage 2 — runtime
FROM alpine:3.20

RUN apk add --no-cache ca-certificates wget tzdata && \
    adduser -D -u 1000 app

COPY --from=builder /out/ /usr/local/bin/

USER app
WORKDIR /home/app

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

ENTRYPOINT ["server"]
