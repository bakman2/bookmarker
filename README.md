# Bookmarker

<img width="1056" height="732" alt="image" src="https://github.com/user-attachments/assets/af3af5ba-fc3e-414f-9de2-66882fd67e29" />


A self-hosted bookmark dashboard with live reachability monitoring.

Bookmarks are organized into categories and rendered as a clean, themeable grid.
Each bookmark is checked periodically (HTTP request or TCP connect) and gets a
green/red status indicator. Every check is recorded, so you can inspect the
reachability history of any bookmark — from a realtime "last 15 minutes, one bar
per check" view up to a full year of daily uptime, including latency stats and
recent failures.

## Features

- Categories with drag & drop reordering (edit mode, press `e` or the ⋯ icon)
- Page title and category names editable inline, title can be hidden
- Reachability checks every 30s with status dot (green = up, red = down)
- Per-bookmark history: 15m / 1h / 3h / 6h / 1d uptime strips with min/avg/max
  latency, uptime percentages for 24h/7d/30d, and a recent-failures list
- Raw checks are kept 7 days, daily rollups 365 days (fully automatic)
- 5 color themes, switchable in edit mode (default, slate, midnight, paper, monokai)
- Live updates across all connected browsers (WebSocket)

## Install with Docker

Requires [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

```bash
git clone https://github.com/bakman2/bookmarker.git   # or just copy the project directory
cd bookmarker
docker compose up -d --build
```

The dashboard is then available at **http://localhost:3000**, and it listens on
**all interfaces by default** — so it is also reachable from other machines on
your network at `http://<host-ip>:3000` (e.g. `http://192.168.1.10:3000`).

All data (bookmarks, theme, check history) lives in a single SQLite file on a
persistent Docker volume, so it survives restarts and rebuilds.

> **Note:** there is no built-in authentication. Anyone who can reach the URL
> can see and edit your bookmarks. On a trusted home network this is usually
> fine; for anything else, restrict access (reverse-proxy auth, firewall rules,
> or a VPN like WireGuard/Tailscale).

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
      build: ./docker
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

  Caddy obtains and renews the HTTPS certificate automatically. **Note:** the
  app itself has no authentication — anyone who can reach the URL can see and
  edit your bookmarks, so use a private network or add your own auth layer
  (reverse-proxy basic auth, VPN like WireGuard/Tailscale) before exposing it
  publicly.

## Development (no Docker)

Requires [Bun](https://bun.sh):

```bash
bun install
bun run src/server.ts     # http://localhost:3000
bun run scripts/seed.ts   # optional: load demo data on an empty database
```

The database file (`bookmarker.db`) is created automatically on first start.
