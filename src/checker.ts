export type CheckResult = { id: number; reachable: boolean; latency_ms: number | null; status_code: number | null; error: string | null };

export async function checkBookmark(b: any): Promise<CheckResult | null> {
  if (!b.enabled || b.check_type === "none") return null;
  const t0 = Date.now();
  try {
    if (b.check_type === "http") {
      const res = await fetch(b.address, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        tls: { rejectUnauthorized: false },
      });
      await res.body?.cancel();
      return { id: b.id, reachable: true, latency_ms: Date.now() - t0, status_code: res.status, error: null };
    }
    if (b.check_type === "tcp") {
      // accept "host:port" and "tcp://host:port"; a port is required
      const raw = b.address.trim().replace(/^tcp:\/\//, "").replace(/\/$/, "");
      const sep = raw.lastIndexOf(":");
      const host = sep > 0 ? raw.slice(0, sep) : "";
      const port = sep > 0 ? Number(raw.slice(sep + 1)) : NaN;
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535)
        return { id: b.id, reachable: false, latency_ms: null, status_code: null, error: "invalid address (expected host:port)" };
      const socket = await Bun.connect({
        hostname: host,
        port: Number(port),
        socket: { data() {} },
      });
      socket.end();
      return { id: b.id, reachable: true, latency_ms: Date.now() - t0, status_code: null, error: null };
    }
  } catch (e: any) {
    console.warn(new Date().toISOString(), `check failed [${b.title}] ${b.check_type} ${b.address}:`, e?.message ?? e, e?.cause?.code ?? "");
    const code = e?.cause?.code ?? "";
    const reason = b.check_type === "tcp" ? "host unreachable" : "unable to access the url";
    return { id: b.id, reachable: false, latency_ms: null, status_code: null, error: code ? `${reason} (${code})` : reason };
  }
  return null;
}
