// reset the admin password:
//   interactive:  docker compose exec bookmarker bun run scripts/reset-password.ts
//   piped:        echo 'newpassword' | docker compose exec -T bookmarker bun run scripts/reset-password.ts
import crypto from "node:crypto";
import { q, hashPassword } from "../src/db";

async function ask(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write(label);
    // no-echo read from the tty via the shell
    const r = Bun.spawnSync(["sh", "-c", "stty -echo; read pw; stty echo; echo; echo $pw"], { stdin: "inherit" });
    return r.stdout.toString().trim();
  }
  return "";
}

let pw1: string, pw2: string;
if (process.stdin.isTTY) {
  pw1 = await ask("new password (min 8 chars): ");
  pw2 = await ask("repeat password: ");
} else {
  const lines = (await new Response(Bun.stdin).text()).split("\n").map((l) => l.trim()).filter(Boolean);
  pw1 = lines[0] ?? "";
  pw2 = lines[1] ?? pw1;
}

if (pw1.length < 8) {
  console.error("too short (min 8 chars)");
  process.exit(1);
}
if (pw1 !== pw2) {
  console.error("passwords do not match");
  process.exit(1);
}

q.setSetting.run("password_hash", hashPassword(pw1));
// rotate the session secret so all existing sessions are invalidated
q.setSetting.run("session_secret", crypto.randomBytes(32).toString("hex"));
console.log("password updated, all sessions invalidated");
