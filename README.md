# Chain Reaction

A "Weakest Link"-style trivia elimination party game. A Go server holds the game state and drives a shared big-screen display, a quizmaster's controller, and each contestant's phone over WebSockets; a small REST API handles room creation, an admin-curated question bank, and public question submissions.

## How a game works

- **Guests need no account.** One person creates a room (picks it up on the big screen — a TV, a laptop plugged into one), gets a 4-letter room code, and shares it (or a `?join=CODE` link). Contestants join from their phones with just a name.
- **The quizmaster runs the game from a separate device** (the "controller") — marking answers correct/incorrect, advancing rounds, managing eliminations and the final 1-on-1 shootout.
- **The question bank** defaults to a shared, admin-curated community set, or a host can paste/upload a one-off set for just that game.
- **Anyone can suggest questions** for the community bank at `/submit.html`; an admin reviews and approves/rejects them at `/admin.html`.

## Local development

Requires Go 1.23+ (see `go.mod`). No Node/build step for the frontend — it's plain ES modules served as static files.

```sh
go run ./cmd/server
```

This serves everything on `http://localhost:8080` (the static frontend from `web/`, the REST API, and the WebSocket endpoint), using a SQLite file at `./data/weakestlink.db` (auto-created, auto-migrated, auto-seeded with the built-in trivia set on first boot) and an ephemeral in-memory session-signing key (fine for local dev — set `SESSION_SIGNING_KEY` explicitly if you want admin sessions to survive a restart).

On first run, set an admin bootstrap password:

```sh
ADMIN_BOOTSTRAP_PASSWORD=devpassword go run ./cmd/server
```

Then log in at `http://localhost:8080/admin.html` with that password.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `./data/weakestlink.db` | SQLite file location |
| `STATIC_DIR` | `./web` | Where the frontend static files are served from |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | Sets the initial admin password on first boot only; ignored afterward |
| `SESSION_SIGNING_KEY` | ephemeral | Base64 string (`openssl rand -base64 32`) signing the admin session cookie |
| `SECURE_COOKIES` | `true` | Set to `false` for local HTTP dev so the login cookie isn't rejected by the browser |

### Running the tests

```sh
go test ./...
```

The room package (`internal/room`) has the heaviest coverage — the ported chain/vote/tie-break/shootout mechanics are unit-tested in isolation from any networking.

### Rotating the admin password

There's a `POST /api/admin/password` endpoint (`{"newPassword": "..."}`, requires an authenticated session) for rotating off the bootstrap password:

```sh
curl -X POST http://localhost:8080/api/admin/password \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"newPassword":"something-longer-and-private"}'
```

(Log in first with `-c cookies.txt` against `/api/admin/login` to get the session cookie into that file.)

## Deploying to a $5 VPS

This targets the smallest tier at any provider (DigitalOcean/Hetzner/Vultr — 1 vCPU / 1GB RAM is plenty), using Docker Compose: the Go binary + a Caddy reverse proxy that handles HTTPS automatically. SQLite lives on a Docker volume; game rooms are in-memory only (never persisted) — a redeploy loses any live game, so redeploy between sessions, not mid-game.

### 1. Point a domain at the server

Buy/use a domain, create an `A` (and `AAAA` if you have IPv6) record pointing at the VPS's public IP, and wait for it to resolve:

```sh
dig +short chain.example.com
```

This must resolve **before** Caddy's first start — it requests a Let's Encrypt certificate via an HTTP-01 challenge on port 80, which needs the domain to already point here.

### 2. Provision and harden the VPS

Ubuntu 24.04 LTS, smallest instance size (1 vCPU / 1GB RAM).

```sh
adduser deploy && usermod -aG sudo deploy
# copy your SSH public key to /home/deploy/.ssh/authorized_keys, then:
# in /etc/ssh/sshd_config: PermitRootLogin no, PasswordAuthentication no
systemctl restart sshd

ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
apt install -y unattended-upgrades fail2ban

# a swap file is cheap insurance on a 1GB box
fallocate -l 1G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 3. Install Docker

```sh
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

### 4. Clone and configure

```sh
git clone <this-repo-url> /opt/weakest-link
cd /opt/weakest-link
cp .env.example .env
# edit .env: set DOMAIN, ADMIN_BOOTSTRAP_PASSWORD, and a fresh SESSION_SIGNING_KEY
openssl rand -base64 32   # paste the output as SESSION_SIGNING_KEY
```

### 5. Start it

```sh
docker compose up -d --build
```

Caddy obtains its certificate on the first incoming HTTPS request. Visit `https://chain.example.com`, confirm it loads over a valid cert, then visit `/admin.html` and log in with your bootstrap password.

### Redeploying after changes

```sh
git pull
docker compose up -d --build
```

This rebuilds and recreates only the `app` container in place — Caddy is untouched (no cert re-issuance, no downtime for it). Because rooms are in-memory, do this between game sessions, not mid-game.

### Logs & health

```sh
docker compose logs -f app
docker compose logs -f caddy
docker compose ps
```

### Backups

SQLite is the only durable state (questions, submissions, admin credentials). The binary has a built-in `-backup` flag using SQLite's `VACUUM INTO` (safe to run live, under WAL mode):

```sh
docker compose exec -T app ./server -backup /app/data/backups/backup-$(date +%F).db
```

Add to the host's crontab (not inside the container):

```
0 3 * * * cd /opt/weakest-link && docker compose exec -T app ./server -backup /app/data/backups/backup-$(date +\%F).db
0 4 * * * find /opt/weakest-link/data/backups -mtime +14 -delete
```

Periodically copy the latest backup off the VPS (`scp`/`rsync` to your laptop, or a cheap object-storage bucket) — a VPS-local backup alone doesn't protect against losing the VPS itself. Actually test a restore occasionally rather than assuming the file is good.

## Project layout

See `CLAUDE.md` for the architecture overview (Go backend package layout, frontend module structure, WebSocket protocol) aimed at anyone (human or AI) picking up this codebase next.
