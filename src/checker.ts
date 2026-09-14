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
      const [host, port] = b.address.replace(/^tcp:\/\//, "").split(":");
      if (!host || !port) return { id: b.id, reachable: false, latency_ms: null, status_code: null, error: "invalid address" };
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
    return { id: b.id, reachable: false, latency_ms: null, status_code: null, error: (e?.cause?.code ? e.cause.code + " " : "") + (e?.message ?? String(e)) };
  }
  return null;
}
