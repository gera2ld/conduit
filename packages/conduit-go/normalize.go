package conduitgo

import "encoding/json"

// normalizeNumbers converts Go numeric types to the JSON model the expression
// engine expects: every number is a float64, exactly as json.Unmarshal would
// produce.
//
// Without this, a caller who writes map[string]any{"limit": 3} in Go gets
// "T0410: $number: unsupported type int" from a definition that works fine when
// the same value arrives over the wire as JSON. The reference implementation
// never sees the problem because its input is already parsed JSON.
func normalizeNumbers(v any) any {
	switch t := v.(type) {
	case int:
		return float64(t)
	case int8:
		return float64(t)
	case int16:
		return float64(t)
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case uint:
		return float64(t)
	case uint8:
		return float64(t)
	case uint16:
		return float64(t)
	case uint32:
		return float64(t)
	case uint64:
		return float64(t)
	case float32:
		return float64(t)
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalizeNumbers(val)
		}
		return out
	case map[string]string:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = val
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeNumbers(val)
		}
		return out
	case []map[string]any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeNumbers(val)
		}
		return out
	}
	return v
}
