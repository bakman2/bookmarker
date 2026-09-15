import { q, db } from "./db";
import { encryptSecret } from "./crypto";
import { checkBookmark } from "./checker";
import os from "node:os";
import dns from "node:dns/promises";

const PORT = Number(process.env.PORT ?? 3000);
const CHECK_INTERVAL = 30_000;

// theme presets: same shape, only the class strings differ
const THEMES: Record<string, any> = {
  default: {
    background: "bg-gray-700",
    heading: "text-gray-200",
    item: "text-white/80 bg-gray-500/40 hover:bg-gray-500/80 hover:shadow cursor-pointer rounded",
    item_subtitle: "text-white/60",
    gap: "gap-2",
  },
  slate: {
    background: "bg-slate-900",
    heading: "text-slate-200",
    item: "text-slate-100 bg-slate-800 hover:bg-slate-700 hover:shadow cursor-pointer rounded",
    item_subtitle: "text-slate-300/80",
    gap: "gap-2",
  },
  // Catppuccin Frappé (https://github.com/catppuccin/catppuccin)
  // base #303446 · mantle #292c3c · surface0 #292c3c ... surface1 #414559 ·
  // surface2 #6268a1 · text #c6d0f5 · subtext0 #a5adce
  frappe: {
    background: "bg-[#303446]",
    heading: "text-[#c6d0f5]",
    item: "text-[#c6d0f5] bg-[#414559] hover:bg-[#6268a1] hover:shadow cursor-pointer rounded",
    item_subtitle: "text-[#a5adce]",
    gap: "gap-2",
  },
  paper: {
    background: "bg-stone-100",
    heading: "text-gray-700",
    item: "text-gray-800 bg-white hover:bg-gray-100 hover:shadow cursor-pointer rounded border border-gray-300",
    item_subtitle: "text-gray-600",
    gap: "gap-2",
  },
  // Catppuccin Mocha (https://github.com/catppuccin/catppuccin)
  // base #1e1e2e · surface0 #313244 · surface1 #45475a · surface2 #585b70 ·
  // text #cdd6f4 · subtext0 #a6adc8
  mocha: {
    background: "bg-[#1e1e2e]",
    heading: "text-[#cdd6f4]",
    item: "text-[#cdd6f4] bg-[#313244] hover:bg-[#45475a] hover:shadow cursor-pointer rounded",
    item_subtitle: "text-[#a6adc8]",
    gap: "gap-2",
  },
};

const DEFAULT_THEME = {
  title_text: "Bookmarks",
  title: "show",
  subtitle: "show",
  ...THEMES.default,
};

// ---- seed on first run ----
if (!q.groups.get()) {
  q.insertGroup.run("General", 0);
  const g = q.groups.get() as any;
  q.insertBookmark.run(g.id, "Example", "https://example.com", null, 0, "http", 0, 1);
}
if (!q.setting.get("theme")) q.setSetting.run("theme", JSON.stringify(DEFAULT_THEME));

// ---- state & broadcast ----
let theme = JSON.parse((q.setting.get("theme")?.value as string) ?? "{}");
type Client = { send: (s: string) => void };
const clients = new Set<Client>();

function buildPayload() {
  const groups = q.groups.all() as any[];
  return {
    theme,
    bookmarks: groups.map((g) => ({
      id: g.id,
      group: g.name,
      sort: g.sort,
      links: (q.bookmarksByGroup.all(g.id) as any[]).map((b) => ({
        id: b.id,
        group_id: b.group_id,
        title: b.title,
        address: b.address,
        description: b.description,
        sort: b.sort,
        check_type: b.check_type,
        is_indicator: !!b.is_indicator,
        reachable: b.reachable === null ? undefined : !!b.reachable,
      })),
    })),
  };
}

function broadcast() {
  const msg = JSON.stringify(buildPayload());
  for (const c of clients) c.send(msg);
}

// ---- reachability loop ----
async function runChecks() {
  const targets = (q.bookmarks.all() as any[]).filter((b) => b.enabled && b.check_type !== "none");
  let changed = false;
  await Promise.all(
    targets.map(async (b) => {
      const r = await checkBookmark(b);
      if (r) {
        console.log(new Date().toISOString(), `check [${b.title}] ${b.check_type} ${b.address} -> ${r.reachable ? "up" : "DOWN"}${r.latency_ms != null ? " " + r.latency_ms + "ms" : ""}${r.status_code ? " (HTTP " + r.status_code + ")" : ""}${r.error ? " " + r.error : ""}`);
        q.setReachable.run(r.reachable ? 1 : 0, b.id);
        q.insertCheck.run(b.id, Date.now(), r.reachable ? 1 : 0, r.latency_ms ?? null, r.status_code ?? null, r.error ?? null);
        changed = true;
      }
    })
  );
  if (changed) broadcast();
}
setInterval(runChecks, CHECK_INTERVAL);
setTimeout(runChecks, 500);

// ---- lan discovery (tcp-based host + port scanning) ----
let lastScanHosts: any[] = [];
let lastPortsHost = "";
let lastScanPorts: any[] = [];
const DISCOVERY_PORTS = [80, 443, 8080, 8443, 22, 3000, 5000, 8006, 8123, 32400, 6789, 7878, 8989, 9117, 9090, 1880, 1883, 8181, 9000];

function sendScanEvent(e: any) {
  const msg = JSON.stringify({ scan: e });
  for (const c of clients) { try { c.send(msg); } catch {} }
}

function probe(host: string, port: number, timeoutMs: number): Promise<"open" | "closed" | "filtered"> {
  return new Promise((resolve) => {
    let done = false;
    let socket: any = null;
    const finish = (r: any) => { if (done) return; done = true; clearTimeout(t); try { socket?.end(); } catch {}; resolve(r); };
    const t = setTimeout(() => finish("filtered"), timeoutMs);
    Bun.connect({ hostname: host, port, socket: { data() {}, error() {}, close() {} } })
      .then((s) => { if (done) { try { s.end(); } catch {} return; } socket = s; finish("open"); })
      .catch((e: any) => finish(e?.code === "ECONNREFUSED" ? "closed" : "filtered"));
  });
}

function parseRange(range: string): string[] {
  if (!range) return [];
  range = range.trim().replace(/^https?:\/\//i, "");
  let base = range, prefix = 24;
  const m = range.match(/^(.+?)\/(\d{1,2})$/);
  if (m) { base = m[1]; prefix = Number(m[2]); }
  const parts = base.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return [];
  const ipToInt = (p: number[]) => ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const intToIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  if (prefix === 32) return [intToIp(ipToInt(parts))];
  const size = 2 ** (32 - prefix);
  if (size > 4096) return [];
  const networkStart = Math.floor(ipToInt(parts) / size) * size;
  const out: string[] = [];
  const last = prefix <= 30 ? size - 1 : size;
  for (let i = 1; i < last; i++) out.push(intToIp(networkStart + i));
  return out;
}

async function scanLan(hosts: string[]) {
  const alive: { ip: string; port: number }[] = [];
  const total = hosts.length * DISCOVERY_PORTS.length;
  let done = 0, lastSent = 0;
  const report = () => { const now = Date.now(); if (now - lastSent > 150 || done === total) { lastSent = now; sendScanEvent({ phase: "hosts", done, total }); } };
  let idx = 0;
  const workers = Array.from({ length: 300 }, async () => {
    while (true) {
      const i = idx++;
      if (i >= total) break;
      const host = hosts[Math.floor(i / DISCOVERY_PORTS.length)];
      const port = DISCOVERY_PORTS[i % DISCOVERY_PORTS.length];
      if ((await probe(host, port, 400)) === "open" && !alive.find((a) => a.ip === host)) alive.push({ ip: host, port });
      done++; report();
    }
  });
  await Promise.all(workers);
  const withTitles = await Promise.all(alive.map(async (h) => {
    const scheme = h.port === 443 || h.port === 8443 ? "https" : "http";
    const url = `${scheme}://${h.ip}:${h.port}`;
    let title = "";
    let hostname = "";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "follow", tls: { rejectUnauthorized: false } });
      title = ((await res.text()).slice(0, 65536).match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim().slice(0, 60);
    } catch {}
    try {
      hostname = (await dns.reverse(h.ip))[0] ?? "";
    } catch {}
    return { ...h, title, hostname, url };
  }));
  lastScanHosts = withTitles;
  sendScanEvent({ phase: "hosts-done", hosts: withTitles });
}

async function scanPorts(host: string) {
  const open: { port: number; title: string; url: string }[] = [];
  const total = 9999;
  // progress spans both passes (pass 1 + retry) so the bar never exceeds 100%
  let scanned = 0, lastSent = 0;
  const report = () => { const now = Date.now(); if (now - lastSent > 150 || scanned === 2 * total) { lastSent = now; sendScanEvent({ phase: "ports", done: scanned, total: 2 * total }); } };
  // moderate concurrency + retry: hammering one host with hundreds of
  // simultaneous SYNs overflows its listen backlog and drops ports randomly
  const scanPortsPass = async (ports: number[], concurrency: number, timeoutMs: number): Promise<number[]> => {
    const found: number[] = [];
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const k = i++;
        if (k >= ports.length) break;
        if ((await probe(host, ports[k], timeoutMs)) === "open") found.push(ports[k]);
        scanned++; report();
      }
    });
    await Promise.all(workers);
    return found.sort((a, b) => a - b);
  };
  const all = Array.from({ length: total }, (_, k) => k + 1);
  const pass1 = await scanPortsPass(all, 250, 300);
  // second chance for ports that timed out (backlog drops, slow hosts)
  const remaining = all.filter((p) => !pass1.includes(p));
  const pass2 = await scanPortsPass(remaining, 200, 500);
  for (const p of [...pass1, ...pass2]) open.push({ port: p, title: "", url: "" });
  open.sort((a, b) => a.port - b.port);
  await Promise.all(open.map(async (o) => {
    const scheme = o.port === 443 || o.port === 8443 ? "https" : "http";
    o.url = `${scheme}://${host}:${o.port}`;
    try {
      const res = await fetch(o.url, { signal: AbortSignal.timeout(1500), redirect: "follow", tls: { rejectUnauthorized: false } });
      o.title = ((await res.text()).slice(0, 65536).match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim().slice(0, 60);
    } catch {}
  }));
  lastPortsHost = host;
  lastScanPorts = open;
  sendScanEvent({ phase: "ports-done", ports: open });
}

// ---- history maintenance: roll up full days, prune old data ----
const DAY_MS = 86_400_000;
function maintainHistory() {
  const now = Date.now();
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  db.exec(`
    INSERT OR REPLACE INTO checks_daily (bookmark_id, day, up, cnt, lat)
    SELECT bookmark_id, CAST(time / ${DAY_MS} AS INTEGER) * ${DAY_MS}, AVG(reachable), COUNT(*), AVG(latency_ms)
    FROM checks WHERE time < ${todayStart}
    GROUP BY bookmark_id, CAST(time / ${DAY_MS} AS INTEGER)
  `);
  q.deleteChecksBefore.run(now - 7 * DAY_MS);
  q.deleteDailyBefore.run(now - 365 * DAY_MS);
}
setInterval(maintainHistory, 3_600_000);
setTimeout(maintainHistory, 5_000);

// ---- helpers ----
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ---- server ----
Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws/bookmarks1234") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }

    // ---- API ----
    if (path.startsWith("/api/")) {
      const seg = path.split("/").filter(Boolean); // ["api", resource, id?, sub?]
      const [, resource, idStr, sub] = seg;
      const id = idStr ? Number(idStr) : null;
      const method = req.method;

      if (resource === "themes" && method === "GET") return json(THEMES);

      if (resource === "lan") {
        if (idStr === "info" && method === "GET") {
          // include the cached scan results so the ui can offer them directly
          try {
            for (const list of Object.values(os.networkInterfaces())) {
              for (const n of list as any[]) {
                if (n.family === "IPv4" && !n.internal) {
                  const [a, b, c] = n.address.split(".").map(Number);
                  return json({ suggestion: `${a}.${b}.${c}.0/24` });
                }
              }
            }
          } catch {}
          return json({ suggestion: "", lastHosts: lastScanHosts, lastPortsHost, lastPorts: lastScanPorts });
        }
        if (idStr === "scan" && method === "POST") {
          const { range } = await body(req);
          const hosts = parseRange(range ?? "");
          if (!hosts.length) return json({ error: "invalid range" }, 400);
          scanLan(hosts);
          return json({ started: true, count: hosts.length });
        }
        if (idStr === "ports" && method === "POST") {
          const { host } = await body(req);
          if (!host || !/^[a-z0-9.\-]+$/i.test(host)) return json({ error: "invalid host" }, 400);
          scanPorts(host);
          return json({ started: true });
        }
      }

      if (resource === "settings" && method === "GET") return json({ theme });

      if (resource === "settings" && method === "PUT") {
        const b = await body(req);
        if (b.theme) {
          theme = b.theme;
          q.setSetting.run("theme", JSON.stringify(theme));
          broadcast();
        }
        return json({ ok: true });
      }

      if (resource === "groups") {
        if (method === "GET") return json(q.groups.all());
        if (method === "POST" && !sub) {
          const b = await body(req);
          const r = q.insertGroup.run(b.name ?? "New group", b.sort ?? 0);
          broadcast();
          return json({ id: r.lastInsertRowid }, 201);
        }
        if (method === "PUT" && id) {
          const b = await body(req);
          q.updateGroup.run(b.name, b.sort ?? 0, id);
          broadcast();
          return json({ ok: true });
        }
        if (sub === "move" && method === "POST" && id) {
          const { direction } = await body(req);
          const all = q.groups.all() as any[];
          const idx = all.findIndex((g) => g.id === id);
          const j = idx + (direction === "up" ? -1 : 1);
          if (idx !== -1 && j >= 0 && j < all.length) {
            // reassign all sorts by current position, swapping the two entries
            [all[idx], all[j]] = [all[j], all[idx]];
            all.forEach((g, i) => q.updateGroup.run(g.name, i, g.id));
            broadcast();
          }
          return json({ ok: true });
        }

        if (method === "DELETE" && id) {
          q.deleteGroup.run(id);
          broadcast();
          return json({ ok: true });
        }
      }

      if (resource === "bookmarks") {
        if (sub === "check" && method === "POST" && id) {
          const b = q.bookmarkById.get(id) as any;
          const r = b ? await checkBookmark(b) : null;
          if (r) {
            console.log(new Date().toISOString(), `check [${b.title}] ${b.check_type} ${b.address} -> ${r.reachable ? "up" : "DOWN"}${r.latency_ms != null ? " " + r.latency_ms + "ms" : ""}${r.status_code ? " (HTTP " + r.status_code + ")" : ""}${r.error ? " " + r.error : ""}`);
            q.setReachable.run(r.reachable ? 1 : 0, id);
            q.insertCheck.run(id, Date.now(), r.reachable ? 1 : 0, r.latency_ms ?? null, r.status_code ?? null, r.error ?? null);
            broadcast();
          }
          return json(r ?? { reachable: null });
        }
        if (sub === "details" && method === "GET" && id) {
          const range = new URL(req.url).searchParams.get("range") ?? "7d";
          const now = Date.now();
          const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
          const b = q.bookmarkById.get(id) as any;
          if (!b) return json({ error: "not found" }, 404);

          // uptime since a point: daily rollups + today's raw rows
          const uptimeSince = (since: number) => {
            let up = 0, cnt = 0;
            for (const r of q.checksDailyRange.all(id, Math.floor(since / DAY_MS) * DAY_MS, now) as any[]) {
              if (r.day >= todayStart) continue;
              up += r.up * r.cnt; cnt += r.cnt;
            }
            const rawFrom = Math.max(since, todayStart);
            for (const r of q.checksRange.all(id, rawFrom, now) as any[]) { up += r.reachable; cnt++; }
            return cnt ? up / cnt : null;
          };

          const bars: any[] = [];
          const RAW_RANGES: Record<string, [number, number]> = {
            "15m": [30 * CHECK_INTERVAL, CHECK_INTERVAL], // 30 bars, one per check
            "1h": [3_600_000, 60_000],
            "3h": [3 * 3_600_000, 180_000],
            "6h": [6 * 3_600_000, 360_000],
            "7d": [7 * DAY_MS, 3 * 3_600_000],
            "1d": [DAY_MS, 1_800_000],
          };
          if (RAW_RANGES[range]) {
            const [span, bucket] = RAW_RANGES[range];
            const rows = q.checksRange.all(id, now - span, now);
            const nbars = Math.round(span / bucket);
            // carry the last known state into buckets without checks
            let carry: number | null = q.lastCheckBefore.get(id, now - span)?.reachable ?? null;
            for (let i = 0; i < nbars; i++) {
              const start = now - span + i * bucket;
              const inb = rows.filter((r: any) => r.time >= start && r.time < start + bucket);
              const cnt = inb.length;
              const lats = inb.map((r: any) => r.latency_ms).filter((v: any) => v != null);
              if (cnt) carry = inb.reduce((a: number, r: any) => a + r.reachable, 0) / cnt;
              bars.push({
                t: start, cnt,
                up: cnt ? (carry as number) : carry,
                lat: cnt ? { min: Math.min(...lats), avg: Math.round(lats.reduce((a: number, v: number) => a + v, 0) / lats.length), max: Math.max(...lats) } : null,
              });
            }
          } else {
            const days = range === "1y" ? 365 : range === "90d" ? 90 : 30;
            const rows = q.checksDailyRange.all(id, Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS, now);
            const map = new Map(rows.map((r: any) => [r.day, r]));
            let carry: number | null = q.lastDailyBefore.get(id, Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS)?.up ?? null;
            for (let i = days; i >= 1; i--) {
              const day = Math.floor((now - i * DAY_MS) / DAY_MS) * DAY_MS;
              const r = map.get(day);
              if (r) carry = r.up;
              bars.push(r ? { t: day, cnt: r.cnt, up: r.up, lat: r.lat ? { min: null, avg: Math.round(r.lat), max: null } : null } : { t: day, cnt: 0, up: carry, lat: null });
            }
          }
          const total = bars.reduce((a, b) => a + b.cnt, 0);
          const upSum = bars.reduce((a, b) => a + (b.up ?? 0) * b.cnt, 0);
          return json({
            bookmark: {
              id: b.id, title: b.title, address: b.address, description: b.description,
              check_type: b.check_type, reachable: b.reachable === null ? undefined : !!b.reachable,
            },
            bars,
            uptime: total ? upSum / total : null,
            uptime_24h: uptimeSince(now - DAY_MS),
            uptime_7d: uptimeSince(now - 7 * DAY_MS),
            uptime_30d: uptimeSince(now - 30 * DAY_MS),
            errors: q.checksErrors.all(id, now - 90 * DAY_MS),
          });
        }
        if (sub === "history" && method === "GET" && id) {
          const range = new URL(req.url).searchParams.get("range") ?? "7d";
          const now = Date.now();
          const bars: { t: number; cnt: number; up: number | null; lat: number | null }[] = [];
          if (range === "1d" || range === "7d") {
            const span = range === "1d" ? DAY_MS : 7 * DAY_MS;
            const bucket = range === "1d" ? 1_800_000 : 3 * 3_600_000;
            const rows = q.checksRange.all(id, now - span, now);
            const nbars = Math.round(span / bucket);
            let carry: number | null = q.lastCheckBefore.get(id, now - span)?.reachable ?? null;
            for (let i = 0; i < nbars; i++) {
              const start = now - span + i * bucket;
              const inb = rows.filter((r: any) => r.time >= start && r.time < start + bucket);
              const cnt = inb.length;
              if (cnt) carry = inb.reduce((a: number, r: any) => a + r.reachable, 0) / cnt;
              bars.push({
                t: start,
                cnt,
                up: cnt ? (carry as number) : carry,
                lat: cnt ? Math.round(inb.reduce((a: number, r: any) => a + (r.latency_ms || 0), 0) / cnt) : null,
              });
            }
          } else {
            const days = range === "1y" ? 365 : range === "90d" ? 90 : 30;
            const rows = q.checksDailyRange.all(id, Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS, now);
            const map = new Map(rows.map((r: any) => [r.day, r]));
            for (let i = days; i >= 1; i--) {
              const day = Math.floor((now - i * DAY_MS) / DAY_MS) * DAY_MS;
              const r = map.get(day);
              bars.push(r ? { t: day, cnt: r.cnt, up: r.up, lat: r.lat ? Math.round(r.lat) : null } : { t: day, cnt: 0, up: null, lat: null });
            }
          }
          const total = bars.reduce((a, b) => a + b.cnt, 0);
          const upSum = bars.reduce((a, b) => a + (b.up ?? 0) * b.cnt, 0);
          return json({ bars, uptime: total ? upSum / total : null });
        }
        if (sub === "move" && method === "POST" && id) {
          const b = q.bookmarkById.get(id) as any;
          if (!b) return json({ error: "not found" }, 404);
          const { group_id, before_id } = await body(req);
          const siblings = (q.bookmarksByGroup.all(Number(group_id)) as any[]).filter(
            (s) => s.id !== b.id
          );
          const idx = before_id ? siblings.findIndex((s) => s.id === Number(before_id)) : -1;
          if (idx === -1) siblings.push({ ...b, group_id: Number(group_id) });
          else siblings.splice(idx, 0, { ...b, group_id: Number(group_id) });
          siblings.forEach((s, i) => q.moveBookmark.run(Number(group_id), i, s.id));
          broadcast();
          return json({ ok: true });
        }
        if (method === "GET") return json(q.bookmarks.all());
        if (method === "POST") {
          const b = await body(req);
          const r = q.insertBookmark.run(
            b.group_id, b.title ?? "New bookmark", b.address ?? "", b.description ?? null,
            b.sort ?? 0, b.check_type ?? "none", b.is_indicator ? 1 : 0, b.enabled === false ? 0 : 1
          );
          broadcast();
          return json({ id: r.lastInsertRowid }, 201);
        }
        if (method === "PUT" && id) {
          const b = await body(req);
          q.updateBookmark.run(
            b.group_id, b.title, b.address, b.description ?? null, b.sort ?? 0,
            b.check_type ?? "none", b.is_indicator ? 1 : 0, b.enabled === false ? 0 : 1, id
          );
          broadcast();
          return json({ ok: true });
        }
        if (method === "DELETE" && id) {
          q.deleteBookmark.run(id);
          broadcast();
          return json({ ok: true });
        }
      }

      return json({ error: "not found" }, 404);
    }

    // ---- static ----
    if (path === "/") return new Response(Bun.file("public/index.html"), { headers: { "cache-control": "no-store" } });
    const file = Bun.file("public" + path);
    if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws as unknown as Client);
      ws.send(JSON.stringify(buildPayload()));
    },
    message(ws, message) {
      if (message === '"init"' || message === "init") {
        ws.send(JSON.stringify(buildPayload()));
      }
    },
    close(ws) {
      clients.delete(ws as unknown as Client);
    },
  },
});

console.log(`bookmarker running on http://localhost:${PORT}`);
