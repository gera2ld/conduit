// Package conduitgo runs a conduit definition — a declarative composition of
// HTTP calls, described by a YAML or JSON document.
//
// This is a Go implementation of the format defined by @gera2ld/conduit. The two
// implementations execute the same conformance corpus, so a definition behaves the
// same way under either. See the repository README for the format itself and
// docs/syntax.md for the full reference.
//
// A run takes three steps: parse the definition, execute it against an input, and
// take the result.
//
//	def, err := conduitgo.Parse(src)
//	if err != nil {
//	        return err
//	}
//	out, err := conduitgo.Run(ctx, def, map[string]any{"user_id": 1}, conduitgo.Options{})
//
// The expression language is JSONata, and the context every expression is evaluated
// against is {input, steps, env}. steps holds the parsed response of each completed
// step, so a later step can read an earlier one's result.
//
// # Versioning
//
// This module is versioned in step with the npm package; the tag is
// packages/conduit-go/vX.Y.Z and the version matches package.json. To adopt a
// specific version:
//
//	go get github.com/gera2ld/conduit/packages/conduit-go@v0.1.3
//
// # Portability
//
// Conduit definitions are meant to run unchanged under both implementations, and
// the shared corpus enforces that. A few JSONata behaviors do not survive the
// crossing, notably regular expressions: a pattern must be a literal (/[0-9]+/,
// not "[0-9]+"), $match reports the position as index in jsonata-js but start/end
// here, and lookahead and backreferences are rejected by this implementation's RE2
// engine. See spec/jsonata-parity.md in the repository for the measurements.
package conduitgo
