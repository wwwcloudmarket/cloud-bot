// api/web-login.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

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

function signSession(payload) {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.WEB_JWT_SECRET)
    .update(json)
    .digest("base64url");
  return `${json}.${sig}`;
}

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "https://wwwcloudmarket.ru";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);

  // Разрешаем preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // Telegram иногда присылает данные через GET, а иногда через POST
    const data =
      req.method === "POST"
        ? typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body
        : req.query;

    if (!data || !data.id || !data.hash)
      return res.status(400).json({ ok: false, error: "bad payload" });

    if (!verifyTelegramInitData(data))
      return res.status(401).json({ ok: false, error: "invalid signature" });

    // сохраняем / обновляем пользователя
    await sb.from("users").upsert({
      tg_user_id: data.id,
      username: data.username || null,
      first_name: data.first_name || null,
      last_name: data.last_name || null,
      photo_url: data.photo_url || null,
      lang_code: data.language_code || null,
    });

    // создаём cookie
    const cookieVal = signSession({
      uid: data.id,
      username: data.username || null,
      first_name: data.first_name || null,
    });

    res.setHeader(
      "Set-Cookie",
      `cm_session=${cookieVal}; Path=/; HttpOnly; SameSite=None; Max-Age=2592000; Secure`
    );

    // редирект на страницу личного кабинета на Тильде
    res.writeHead(302, { Location: "https://wwwcloudmarket.ru/lk" });
    res.end();

  } catch (e) {
    console.error("web-login error:", e);
    res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
