// Package questionbank owns question parsing and storage — the one place
// question data logic lives, reused by room custom-bank uploads, admin bulk
// import, and public submissions.
package questionbank

import (
	"encoding/csv"
	"encoding/json"
	"strings"

	"weakestlink/internal/room"
)

// ParseCSV parses `question,answer` CSV text (quoted-field aware via the
// standard library, tolerant of an optional "question,answer" header row),
// ported from the original hand-rolled parseCSVQuestions().
func ParseCSV(text string) ([]room.Question, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	r := csv.NewReader(strings.NewReader(text))
	r.FieldsPerRecord = -1 // tolerate ragged rows rather than rejecting the whole file
	rawRows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	var out []room.Question
	for i, row := range rawRows {
		if len(row) < 2 {
			continue
		}
		q := strings.TrimSpace(row[0])
		a := strings.TrimSpace(row[1])
		if q == "" || a == "" {
			continue
		}
		if i == 0 && strings.EqualFold(q, "question") && strings.EqualFold(a, "answer") {
			continue
		}
		out = append(out, room.Question{Q: q, A: a})
	}
	return out, nil
}

// ParseLines parses "Question | Answer" lines, one per row, ignoring blanks
// and lines with no separator — the line-based fallback from the original
// parseCustomQuestions().
func ParseLines(text string) []room.Question {
	var out []room.Question
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		idx := strings.Index(line, "|")
		if idx == -1 {
			continue
		}
		q := strings.TrimSpace(line[:idx])
		a := strings.TrimSpace(line[idx+1:])
		if q != "" && a != "" {
			out = append(out, room.Question{Q: q, A: a})
		}
	}
	return out
}

// jsonItem accepts a {q,a} or {question,answer} object shape.
type jsonItem struct {
	Q        string `json:"q"`
	Question string `json:"question"`
	A        string `json:"a"`
	Answer   string `json:"answer"`
}

// ParseJSON parses a JSON array of [q,a] pairs or {q,a}/{question,answer}
// objects. ok is false (not an error) when the text isn't a JSON array at
// all, so ParseText can fall back to line-based parsing exactly like the
// original client-side parser did.
func ParseJSON(text string) (qs []room.Question, ok bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "[") {
		return nil, false
	}
	var rawItems []json.RawMessage
	if err := json.Unmarshal([]byte(text), &rawItems); err != nil {
		return nil, false
	}
	for _, raw := range rawItems {
		var pair [2]string
		if err := json.Unmarshal(raw, &pair); err == nil && pair[0] != "" && pair[1] != "" {
			qs = append(qs, room.Question{Q: pair[0], A: pair[1]})
			continue
		}
		var item jsonItem
		if err := json.Unmarshal(raw, &item); err == nil {
			q := firstNonEmpty(item.Q, item.Question)
			a := firstNonEmpty(item.A, item.Answer)
			if q != "" && a != "" {
				qs = append(qs, room.Question{Q: q, A: a})
			}
		}
	}
	return qs, len(qs) > 0
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

// ParseText tries JSON first, then falls back to line-based "Question | Answer"
// parsing — the same dispatch parseCustomQuestions() used client-side.
func ParseText(text string) []room.Question {
	if qs, ok := ParseJSON(text); ok {
		return qs
	}
	return ParseLines(text)
}

// Clamp trims a parsed batch to sane limits before it becomes authoritative
// data (used for the public, unauthenticated submission endpoints — admin
// imports are trusted and skip this). Over-long fields are truncated rather
// than dropped so a slightly-too-long paste doesn't silently vanish.
func Clamp(qs []room.Question, maxRows, maxQuestionLen, maxAnswerLen int) []room.Question {
	if len(qs) > maxRows {
		qs = qs[:maxRows]
	}
	out := make([]room.Question, len(qs))
	for i, q := range qs {
		out[i] = room.Question{Q: truncateRunes(q.Q, maxQuestionLen), A: truncateRunes(q.A, maxAnswerLen)}
	}
	return out
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
