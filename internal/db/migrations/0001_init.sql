-- Single-admin credential row: a real users/roles table would be overkill
-- for a solo-hosted party game with one operator.
CREATE TABLE admin (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The global, curated, approved question bank every room draws from by default.
CREATE TABLE questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('seed','admin','submission')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_questions_created ON questions(created_at);

-- Full-text search over the bank, used by the admin question-manager search box.
CREATE VIRTUAL TABLE questions_fts USING fts5(
    question, answer, content='questions', content_rowid='id'
);
CREATE TRIGGER questions_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, question, answer) VALUES (new.id, new.question, new.answer);
END;
CREATE TRIGGER questions_ad AFTER DELETE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, question, answer) VALUES ('delete', old.id, old.question, old.answer);
END;
CREATE TRIGGER questions_au AFTER UPDATE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, question, answer) VALUES ('delete', old.id, old.question, old.answer);
  INSERT INTO questions_fts(rowid, question, answer) VALUES (new.id, new.question, new.answer);
END;

-- Public/guest submissions moderation queue.
CREATE TABLE submissions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    question              TEXT NOT NULL,
    answer                TEXT NOT NULL,
    submitter_name        TEXT,
    note                  TEXT,
    status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    reject_reason         TEXT,
    batch_id              TEXT,
    approved_question_id  INTEGER REFERENCES questions(id),
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at           TEXT
);
CREATE INDEX idx_submissions_status ON submissions(status, created_at);
