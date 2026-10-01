# Single entry point for both toolchains.
#
# package.json remains the source of truth for TypeScript scripts; this file
# orchestrates them alongside the Go work so nothing has to remember which
# package manager owns which command. Run `just` to list recipes.

go_dir := "packages/conduit-go"

# List available recipes
default:
    @just --list --unsorted

# Run everything CI runs
ci: check check-go test

# Typecheck, lint and format the TypeScript sources
check:
    bun run check

# Go vet and formatting check
check-go:
    cd {{ go_dir }} && gofmt -l . | (! grep .) && go vet ./...

# Unit tests, conformance corpus, and the Go expression-engine gate
test: test-ts test-go
    @echo "all suites green"

# TypeScript unit tests, plus the spec suite via `bun test`
test-ts:
    bun run test

# Conformance corpus only (excludes the 10s timeout case)
spec:
    bun run spec

# Conformance corpus including the timeout case
spec-slow:
    CONDUIT_SPEC_SLOW=1 bun run spec

# Go expression-engine parity gate
test-go:
    cd {{ go_dir }} && go test ./...

# Format TypeScript and Go
fmt: fmt-ts fmt-go

# Format TypeScript via the project check script
fmt-ts:
    bun run check

# Format Go sources
fmt-go:
    cd {{ go_dir }} && gofmt -w .

# Record jsonata-js results and sync the Go embed copy
parity:
    # Run after editing the expression cases in spec/gen-parity-cases.ts. The
    # recorded values must come from jsonata-js, never from a human.
    bun run spec/gen-parity-cases.ts
    bun run spec/sync-parity.ts

# Build the npm package
build:
    bun run build

# Install dependencies for both toolchains
deps:
    bun install
    cd {{ go_dir }} && go mod download
