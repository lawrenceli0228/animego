# go-api Makefile — convenience wrapper around the workflow commands.
#
# Most targets just exec into the canonical `go` / `sqlc` / `migrate`
# invocations so contributors do not have to remember the exact flags.
# Run `make help` for the catalogue.

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Available targets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ----- Build / test -------------------------------------------------------

.PHONY: build
build: ## Build all binaries (go build ./...).
	go build ./...

.PHONY: vet
vet: ## Run go vet across the module.
	go vet ./...

.PHONY: test
test: ## Run unit tests with race detector.
	go test -race -timeout=60s ./...

.PHONY: test-cover
test-cover: ## Run unit tests with coverage summary.
	go test -race -cover -timeout=60s ./...

.PHONY: test-integration
test-integration: ## Run testcontainers integration tests (requires Docker).
	go test -race -tags=integration -timeout=300s ./test/integration/...

# ----- sqlc ---------------------------------------------------------------

.PHONY: sqlc-generate
sqlc-generate: ## Regenerate internal/db/gen from internal/db/queries.
	sqlc generate

.PHONY: sqlc-vet
sqlc-vet: ## Static-analyse SQL queries against the schema.
	sqlc vet

# ----- Migrations ---------------------------------------------------------
#
# All migrate targets read DATABASE_URL from the environment.  Source it
# from .env first:  `set -a; source .env; set +a`.

.PHONY: migrate-up
migrate-up: ## Apply outstanding migrations to $$DATABASE_URL.
	migrate -path migrations -database "$$DATABASE_URL" up

.PHONY: migrate-down
migrate-down: ## Roll back the most recent migration.
	migrate -path migrations -database "$$DATABASE_URL" down 1

.PHONY: migrate-status
migrate-status: ## Print the current migration version.
	migrate -path migrations -database "$$DATABASE_URL" version

# ----- Mongo → Postgres ---------------------------------------------------

.PHONY: migrate-mongo-dryrun
migrate-mongo-dryrun: ## Dry-run the Mongo → PG migration tool.
	go run ./cmd/migrate-mongo --dry-run --pg-uri="$$DATABASE_URL"

.PHONY: migrate-mongo-commit
migrate-mongo-commit: ## Commit Mongo → PG migration (writes to PG).
	go run ./cmd/migrate-mongo --commit --pg-uri="$$DATABASE_URL"

.PHONY: parity-check
parity-check: ## Run the 10-field × N-sample parity check vs Mongo.
	go run ./cmd/parity-check --sample=1000 --pg-uri="$$DATABASE_URL"

# ----- Dev server ---------------------------------------------------------

.PHONY: run
run: ## Run go-api server with the dev DATABASE_URL (no live reload).
	go run ./cmd/server
