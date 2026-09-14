async function getKey(): Uint8Array {
  let secret = process.env.BOOKMARKER_SECRET;
  if (!secret) {
    secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    Bun.write(".env", `BOOKMARKER_SECRET=${secret}\n`);
    process.env.BOOKMARKER_SECRET = secret;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const keyP = getKey();

export async function encryptSecret(plain: string): Promise<string> {
  const key = await keyP;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(enc)]).toString("base64");
}

export async function decryptSecret(blob: string | null): Promise<string> {
  if (!blob) return "";
  const key = await keyP;
  const buf = Buffer.from(blob, "base64");
  const dec = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.subarray(0, 12) },
    key,
    buf.subarray(12)
  );
  return new TextDecoder().decode(dec);
}
