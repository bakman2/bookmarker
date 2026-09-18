# Bookmarker

<img width="1049" height="1056" alt="SCR-20260915-size" src="https://github.com/user-attachments/assets/9ef3f6a8-5303-4346-900a-00907bec1090" />

<img width="1048" height="963" alt="SCR-20260915-sjdl" src="https://github.com/user-attachments/assets/cd636da0-30aa-43de-a49d-e846d8d7c00c" />

A self-hosted bookmark dashboard with live reachability monitoring.

Bookmarks are organized into categories and rendered as a clean, themeable grid.
Each bookmark is checked periodically (HTTP request or TCP connect) and gets a
green/red status indicator. Every check is recorded, so you can inspect the
reachability history of any bookmark — from a realtime "last 15 minutes, one bar
per check" view up to a full year of daily uptime, including latency stats and
recent failures.

## Features

- Categories with drag & drop reordering (edit mode, press `cmd/ctrl+e` or the ⋯ icon on the right top)
- Page title and category names editable inline, title can be hidden
- Reachability checks every 30s with status dot (green = up, red = down)
- Per-bookmark history: 15m / 1h / 3h / 6h / 1d uptime strips with min/avg/max
  latency, uptime percentages for 24h/7d/30d, and a recent-failures list
- Raw checks are kept 7 days, daily rollups 365 days (fully automatic)
- 5 color themes, switchable in edit mode (default, slate, midnight, paper, monokai)
- Live updates across all connected browsers (WebSocket)
- Discovery mode to scan for servers and ports on the local network for easy adding of bookmarks
- Admin password for edit mode; viewing stays open to everyone on the network

## Install with Docker

Requires [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

### Option A: prebuilt image from Docker Hub (recommended)

```yaml
# compose.yaml
services:
  bookmarker:
    image: z1rconium/bookmarker:latest
    ports:
      - "3000:3000"
    volumes:
      - bookmarker-data:/data
    restart: unless-stopped

volumes:
  bookmarker-data:
```

```bash
docker compose up -d
```

Images are published for `linux/amd64` and `linux/arm64` (Apple Silicon, Raspberry Pi, etc.).

### Option B: build from source

```bash
git clone https://github.com/bakman2/bookmarker.git   # or just copy the project directory
cd bookmarker
docker compose up -d --build
```

## Update

```bash
git pull
sudo docker compose up -d --build
```

If you use the prebuilt image (Option A), update instead with:

```bash
docker compose pull
docker compose up -d
```

The dashboard is then available at **http://localhost:3000**, and it listens on
**all interfaces by default** — so it is also reachable from other machines on
your network at `http://<host-ip>:3000` (e.g. `http://192.168.1.10:3000`).

All data (bookmarks, theme, check history) lives in a single SQLite file on a
persistent Docker volume, so it survives restarts and rebuilds.

## Admin password

Viewing the dashboard is open to everyone who can reach it. **Editing**
(add/edit/delete bookmarks and categories, themes) requires the admin
password.

- **First run:** open the dashboard and click the edit icon (or press
  `cmd/ctrl+e`). You are prompted to set the admin password (min. 8 chars).
  This one-time prompt appears only while no password exists.
- **Sessions** last 30 days per browser and survive container restarts.
  Logging out invalidates only the local browser.

### Set the password via environment (optional, before first start)

If you prefer not to use the web prompt, seed the password on first start:

```yaml
# compose.yaml
services:
  bookmarker:
    environment:
      - BOOKMARKER_PASSWORD=yourpassword   # only used if no password exists yet
```

`docker compose up -d --build` then skips the setup prompt. The variable is
only read while no password is set — removing it later changes nothing.

### Reset password

```bash
# interactive (type the new password twice)
docker compose exec bookmarker bun run scripts/reset-password.ts

# or non-interactive
echo 'yournewpassword' | docker compose exec -T bookmarker bun run scripts/reset-password.ts
```

Resetting rotates the session secret, which logs out every browser

> **Note:** even with a password set, anyone who can reach the URL can still
> *see* your bookmarks. On an untrusted network, additionally restrict access
> (reverse-proxy auth, firewall rules, or a VPN like WireGuard/Tailscale).

### Useful commands

```bash
docker compose logs -f bookmarker   # follow logs
docker compose stop                 # stop (data is kept)
docker compose down                 # remove container (data is kept)
docker compose down -v              # ⚠️ remove container AND all data
```

### Backup

```bash
docker run --rm -v bookmarker-data:/data -v "$PWD":/backup oven/bun \
  cp /data/bookmarker.db /backup/
```

Restore by copying the file back into the volume and restarting.

## Restricting or widening access

By default the app is exposed to your **entire local network on port 3000** —
any device on the LAN can open `http://<host-ip>:3000` and view and edit your
bookmarks. Tighten or widen it as follows:

- **Restrict to localhost only** (if you want it private on the host):

  ```yaml
  ports:
    - "127.0.0.1:3000:3000"
  ```

- **From anywhere (internet)** — don't expose the port directly. Put it behind
  a reverse proxy with TLS, e.g. [Caddy](https://caddyserver.com/) or
  [Traefik](https://traefik.io/), typically on a VPS:

  ```yaml
  services:
    bookmarker:
      image: z1rconium/bookmarker:latest
      volumes:
        - bookmarker-data:/data
      restart: unless-stopped

    caddy:
      image: caddy:2
      ports: ["80:80", "443:443"]
      volumes:
        - ./Caddyfile:/etc/caddy/Caddyfile
        - caddy-data:/data
      restart: unless-stopped

  volumes:
    bookmarker-data:
    caddy-data:
  ```

  with a one-line `Caddyfile` next to your compose file:

  ```
  bookmarks.example.com {
      reverse_proxy bookmarker:3000
  }
  ```

  Caddy obtains and renews the HTTPS certificate automatically. **Note:**
  anyone who can reach the URL can see your bookmarks (editing requires the
  admin password, see above), so use a private network or add your own auth
  layer (reverse-proxy basic auth, VPN like WireGuard/Tailscale) before
  exposing it publicly.

## Development (no Docker)

Requires [Bun](https://bun.sh):

```bash
bun install
bun run src/server.ts     # http://localhost:3000
bun run scripts/seed.ts   # optional: load demo data on an empty database
```

The database file (`bookmarker.db`) is created automatically on first start.
