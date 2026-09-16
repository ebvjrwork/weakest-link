# Chain Reaction — project guide

A "Weakest Link"-style trivia elimination party game. Originally a single-file client-only HTML app using PeerJS (WebRTC) for networking; rewritten into a Go backend + buildless ES-module frontend so a real admin/question-bank/moderation system could exist.

## Architecture

**The Go server is authoritative for all game state.** Each room is an actor: one goroutine owning a `*room.State` exclusively, driven by a single `select` loop over an inbox channel (client messages, attach/detach events) and a 500ms ticker (countdown→playing transitions, round-timer expiry). Because only that goroutine ever touches the state, none of the ~20 game-action methods (`DoMarkCorrect`, `DoBankChain`, `resolveVotes`, shootout logic, etc.) need any locking — "share memory by communicating," not a mutex.

There are three WebSocket roles per room: **player** (a contestant's phone), **controller** (the quizmaster's remote — the only role that can mutate game state), and **host** (the shared big-screen/TV display — read-only, gets the same sanitized no-answer view a player does). Room lifecycle (create/join) goes through REST first; gameplay is entirely over WebSocket once connected. See "WebSocket protocol" below.

SQLite (`modernc.org/sqlite`, pure Go, no CGO) is used **only** for the question bank, submission moderation queue, and the single admin credential row — never for game state, which is intentionally ephemeral (a server restart loses any live game; redeploy between sessions).

### Go package layout

```
cmd/server/main.go       config from env vars, DB open+migrate+seed, wiring, graceful shutdown, -backup flag
internal/
  room/                  pure state machine + the Room actor — zero DB code
    state.go               State/Player/Question/Shootout structs, NewState, PullQuestion, GenRoomCode
    actions.go              all Do* game-action methods, ported 1:1 from the original JS do* functions
                             (chain/banking, voting/tie-break/elimination, shootout, lobby management,
                             Join/AttachPlayer/DetachPlayer/SubmitVote/CallBank/Rename)
    room.go                  the Room actor: inbox+ticker select loop, conn registries, broadcast, dispatch
    sanitize.go               ToPlayerState / ToControllerState DTOs — the ONE place answer-redaction happens
                             (players/host never receive the current answer text; only the controller does)
    registry.go                Manager: room-code -> *Room directory (a plain mutex-guarded map, no game
                             logic runs under its lock)
    room_test.go                 unit tests covering vote-tie-break and shootout-early-decision logic
                             directly against State, no networking involved
  ws/                    transport only, no game rules, no DB — Conn (buffered send queue + read/write/
                         heartbeat pumps) and the client message envelope/action-name constants
  questionbank/          SQLite-backed question store + the shared parsing logic (CSV / JSON / "Q | A"
                         lines), reused by: room custom-bank REST upload, admin bulk import, and public
                         submissions. seed.go embeds the ~500 original built-in trivia questions, inserted
                         once on first boot if the questions table is empty.
  auth/                  single-admin bcrypt + HMAC-signed session cookie (no JWT library, no users table)
  db/                    sqlite.Open() (WAL mode, busy_timeout, foreign_keys) + migrations/*.sql runner
  httpapi/                the HTTP layer: router.go/server.go wiring, rooms.go (REST bootstrap), ws.go
                         (the /ws upgrade handler — the one file that bridges internal/ws and internal/room),
                         admin_auth.go, admin_questions.go, admin_submissions.go, public_submissions.go
```

### WebSocket protocol

Room lifecycle is REST, gameplay is WebSocket. There is deliberately **no "join"/"joinController" handshake message** — identity comes entirely from the connection URL, so the server can push the first state message immediately:

- `POST /api/rooms` `{roundDuration, bank:{mode:"community"|"custom", questions?}}` → `{roomCode}`
- `GET /api/rooms/{code}` → `{exists, phase, playerCount}` (join-screen pre-flight)
- `POST /api/rooms/{code}/players` `{name, rejoinId?, rejoinToken?}` → `{playerId, playerToken}` (404 room gone, 409 name taken/game in progress)
- `GET /ws?role=player&code=X&playerId=Y&token=Z` / `?role=controller&code=X` / `?role=host&code=X`

Client→server messages: `{type:'vote', targetId}`, `{type:'callBank'}`, `{type:'rename', newName}` (players); `{type:'control', action, arg}` (controller — see `internal/ws/protocol.go` for the full 19-action list, e.g. `markCorrect`, `bankChain`, `setQuestionBank`).

Server→client: `{type:'state', state}` (to each player, sanitized — no answer), `{type:'controllerState', state}` (full state incl. answer + activity log), `{type:'hostState', state}` (same shape as player state), `{type:'questionBankData', questions}`, `{type:'kicked'}`, `{type:'renameFailed', reason}`, `{type:'roomClosed'}`. An attach rejection (bad token, room gone) has no write pump running yet, so it's signaled via the WebSocket **close frame's reason string**, not a JSON message — the frontend's `net.js` surfaces this as `{code, reason}` on the `'close'` event.

Ticking clocks need zero server chatter: the server sends absolute `timer.endsAt`/`countdownEndsAt` epoch-ms timestamps exactly once per real phase change, and every client counts down locally against `Date.now()` (see `main.js`'s `tickLiveTimers`).

### Frontend layout (buildless — plain `<script type="module">`, no bundler)

```
web/
  index.html / admin.html / submit.html     three independent entry points
  css/  base.css (shared game theme+components) / host.css / controller.css / player.css
        tool-base.css (shared admin+submit "internal tool" look) / admin.css / submit.css
  js/
    core/    dom.js  storage.js  net.js (WebSocket wrapper mirroring the old PeerJS DataConnection
             interface + REST fetch helpers)  sound.js (Web Audio synthesized SFX, no audio files)
             questions-parse.js (client-side preview parser — server always re-validates independently)
    game/    state.js (role/HOST/CTRL/P globals, Actions/Binds/Changes registries, render() pub-sub)
             components.js (shared render-to-HTML-string helpers)  host.js  controller.js  player.js
             main.js (landing view, render() dispatcher, global event delegation, live timer ticker, bootstrap)
    admin/   api.js  admin-app.js   — fully separate mini-app, does not import anything from game/
    submit/  submit-app.js           — same, fully separate
```

`web/js/game/main.js` is the render dispatcher: it imports `host.js`/`controller.js`/`player.js`'s view functions and picks one based on `role`/`localView` from `state.js`. Those three role modules never import each other or `main.js` (no cycles) — they only import from `core/` and `game/state.js`+`game/components.js`.

Sound ownership is split deliberately so a room full of devices doesn't all beep in chaotic unison: the **host** (shared screen/speakers) plays the communal gameplay SFX (tick, correct, wrong, bank, eliminate, win); the **player** only plays two personal moments (their own elimination, entering gameover); the **controller** plays nothing (visual `.flash` feedback on keyboard shortcuts instead).

## Running locally

```sh
ADMIN_BOOTSTRAP_PASSWORD=devpassword go run ./cmd/server
```

Serves everything (static frontend + REST + WebSocket) on `:8080` from one process — no separate frontend dev server. SQLite auto-creates/migrates/seeds at `./data/weakestlink.db`.

```sh
go test ./...             # internal/room and internal/questionbank have real coverage
go vet ./...
```

## Deploying

See `README.md` for the full $5-VPS Docker Compose + Caddy runbook (domain setup, hardening, backups via the binary's `-backup` flag using `VACUUM INTO`).

## Conventions worth preserving

- Keep the frontend buildless. The only external asset dependency is Google Fonts; no bundler, no framework, no npm.
- Keep `internal/room` free of network/DB imports — it's the one package that's fully unit-testable in isolation, and that's load-bearing for confidence in the trickiest logic (tie-breaking, shootout math).
- Never send the current question's answer to a player or the host — only the controller. This redaction lives entirely in `internal/room/sanitize.go`; don't bypass it by hand-building a different payload elsewhere.
- Rooms are intentionally not persisted. Don't add game-state persistence without discussing it first — it changes the redeploy story described in the README.
