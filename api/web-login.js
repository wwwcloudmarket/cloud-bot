// api/web-login.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

//
// ————— 1. Проверка подписи от Telegram —————
//
function verifyTelegramInitData(data) {
  const { hash, ...rest } = data;
  const secret = crypto.createHash("sha256").update(process.env.BOT_TOKEN).digest();
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");
  const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return hmac === hash;
}

//
// ————— 2. Создание подписи для сессии (JWT-like) —————
//
function signSession(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.WEB_JWT_SECRET)
    .update(json)
    .digest("base64url");
  return `${json}.${sig}`;
}

//
// ————— 3. CORS helper (для вызова с Тильды) —————
//
function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "https://wwwcloudmarket.ru";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

//
// ————— 4. Основной handler —————
//
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || !body.id || !body.hash)
      return res.status(400).json({ ok: false, error: "bad payload" });

    // — Проверяем подпись Telegram —
    if (!verifyTelegramInitData(body)) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    // — Сохраняем / обновляем пользователя в Supabase —
    await sb.from("users").upsert({
      tg_user_id: body.id,
      username: body.username || null,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      photo_url: body.photo_url || null,
      lang_code: body.language_code || null,
    });

    // — Формируем cookie-сессию —
    const cookieVal = signSession({
      uid: body.id,
      username: body.username || null,
      first_name: body.first_name || null,
    });

    res.setHeader(
      "Set-Cookie",
      `cm_session=${cookieVal}; Path=/; HttpOnly; SameSite=None; Max-Age=2592000; Secure`
    );

    // — После успешного входа: редирект на ЛК (страница Тильды) —
    return res.redirect(302, "https://wwwcloudmarket.ru/lk");

  } catch (e) {
    console.error("web-login error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
