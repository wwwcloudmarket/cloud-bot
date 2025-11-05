// api/web-login.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

function verifyTelegramInitData(data) {
  // data — объект с полями от Telegram Login Widget
  const { hash, ...rest } = data;
  const secret = crypto.createHash("sha256").update(process.env.BOT_TOKEN).digest(); // key = sha256(BOT_TOKEN)
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");
  const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return hmac === hash;
}

function signSession(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.WEB_JWT_SECRET).update(json).digest("base64url");
  return `${json}.${sig}`;
}
function verifySession(cookieVal) {
  if (!cookieVal) return null;
  const [json, sig] = cookieVal.split(".");
  const check = crypto.createHmac("sha256", process.env.WEB_JWT_SECRET).update(json).digest("base64url");
  if (sig !== check) return null;
  try { return JSON.parse(Buffer.from(json, "base64url").toString()); } catch { return null; }
}

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || !body.id || !body.hash) return res.status(400).json({ ok: false, error: "bad payload" });

    if (!verifyTelegramInitData(body)) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // upsert пользователя
    await sb.from("users").upsert({
      tg_user_id: body.id,
      username: body.username || null,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      lang_code: body.language_code || null,
    });

    // устанавливаем куку сессии (1 месяц)
    const cookieVal = signSession({ uid: body.id, u: body.username || null });
    const isSecure = true;
    res.setHeader(
      "Set-Cookie",
      `cm_session=${cookieVal}; Path=/; HttpOnly; SameSite=None; Max-Age=2592000; ${isSecure ? "Secure" : ""}`
    );

    // 🔹 Перенаправляем на страницу личного кабинета
return res.redirect(302, "https://wwwcloudmarket.ru/lk");
  } catch (e) {
    console.error("web-login error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
