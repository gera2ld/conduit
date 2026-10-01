# Single entry point for both toolchains.
#
# package.json owns the TypeScript scripts — one manifest for the published
# package and one private workspace root. This file
# orchestrates them alongside the Go work so nothing has to remember which
# package owns which command. Run `just` to list recipes.

# Positional arguments reach recipes intact rather than being interpolated, so a
# variadic recipe can forward them without the shell re-quoting them. Only
# `conduit` takes variadic arguments today.
set positional-arguments

# Derived from the packages/ directory rather than hard-coded, so adding a
# package does not mean editing this file.
go_dir := `for d in packages/*/; do [ -f "$d/go.mod" ] && echo "$d"; done | head -1 | sed 's:/$::'`

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

# Conformance corpus including the timeout case, both implementations
spec-slow: spec-slow-go
    CONDUIT_SPEC_SLOW=1 bun run spec

# Go expression-engine parity gate, and the shared corpus run against Go
test-go:
    cd {{ go_dir }} && go test ./...

# Same corpus, Go side, including the 10s timeout case
spec-slow-go:
    cd {{ go_dir }} && CONDUIT_SPEC_SLOW=1 go test -count=1 -run TestConformance .

# Format TypeScript and Go
fmt: fmt-ts fmt-go

# Format TypeScript via the project check script
fmt-ts:
    bun run check

# Format Go sources
fmt-go:
    cd {{ go_dir }} && gofmt -w .

# Stage the files each TypeScript package needs to pack
prepare:
    # Generic over any JS package, so a package's own scripts never reach into
    # the parent directory for these.
    for d in packages/*/; do \
      [ -f "$d/package.json" ] || continue; \
      cp LICENSE "$d/LICENSE"; \
      cp README.md "$d/README.md"; \
    done

# Record jsonata-js results and sync the Go embed copy
parity:
    # Run after editing the expression cases in spec/gen-parity-cases.ts. The
    # recorded values must come from jsonata-js, never from a human.
    bun run spec/gen-parity-cases.ts
    bun run spec/sync-parity.ts

# Build every workspace package
build: prepare
    bun run --filter '*' build

# Run the CLI from source
[script]
conduit *args:
    #!/usr/bin/env bash
    # "$@" with [script] and `set positional-arguments` passes each argument
    # through untouched. Interpolating {{ args }} would strip the shell quoting,
    # so -i '{"user_id": 1}' would arrive as {user_id: 1} and be rejected.
    bun --filter '*' conduit "$@"

# Install dependencies for both toolchains
deps:
    bun install
    cd {{ go_dir }} && go mod download

# Tag the Go module with the current npm version
tag-go:
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(bun -e 'process.stdout.write(require("./packages/conduit-ts/package.json").version)')
    tag="{{ go_dir }}/v$version"
    if git rev-parse "$tag" >/dev/null 2>&1; then
      echo "$tag already exists at $(git rev-parse --short "$tag")"
      exit 1
    fi
    git tag "$tag"
    echo "tagged $tag at $(git rev-parse --short HEAD)"
    echo "push it with: git push origin $tag"
