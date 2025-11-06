import crypto from "node:crypto";

export function normalizePhone(raw) {
  const d = raw.replace(/[^\d+]/g, "");
  if (/^8\d{10}$/.test(d)) return "+7" + d.slice(1);
  if (/^\+?\d{10,15}$/.test(d)) return d.startsWith("+") ? d : "+" + d;
  return d;
}

export function randomCode6() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

export function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

export function signAppToken(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.WEB_JWT_SECRET).update(json).digest("base64url");
  return `${json}.${sig}`;
}

export function verifyAppToken(token) {
  try {
    const [json, sig] = token.split(".");
    const check = crypto.createHmac("sha256", process.env.WEB_JWT_SECRET).update(json).digest("base64url");
    if (sig !== check) return null;
    return JSON.parse(Buffer.from(json, "base64url").toString());
  } catch { return null; }
}
