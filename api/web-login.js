// api/web-login.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_JWT_SECRET = process.env.WEB_JWT_SECRET;

// домен Тильды / сайта
const TILDA_ORIGIN = process.env.TILDA_ORIGIN || "https://wwwcloudmarket.ru";

// страница ЛК, куда редиректим после логина через Telegram-widget
const LK_URL = process.env.LK_URL || "https://wwwcloudmarket.ru/lk";

function verifyTelegramInitData(data) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

  const { hash, ...rest } = data;

  // опционально — не принимать сильно старые логины
  if (rest.auth_date) {
    const authDate = Number(rest.auth_date);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = 60 * 60 * 24; // 24 часа
    if (Number.isFinite(authDate) && now - authDate > maxAge) {
      return false;
    }
  }

  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();

  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  return hmac === hash;
}

function signSession(payload) {
  if (!WEB_JWT_SECRET) throw new Error("WEB_JWT_SECRET is not set");

  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", WEB_JWT_SECRET)
    .update(json)
    .digest("base64url");

  return `${json}.${sig}`;
}

// ——— CORS
function cors(req, res) {
  const originHeader = req.headers.origin;
  const origin =
    originHeader && originHeader.startsWith("http")
      ? originHeader
      : TILDA_ORIGIN;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export default async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (!BOT_TOKEN || !WEB_JWT_SECRET) {
      console.error("Missing BOT_TOKEN or WEB_JWT_SECRET");
      return res
        .status(500)
        .json({ ok: false, error: "server misconfigured" });
    }

    const data =
      req.method === "POST"
        ? typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body
        : req.query;

    if (!data || !data.id || !data.hash) {
      return res.status(400).json({ ok: false, error: "bad payload" });
    }

    if (!verifyTelegramInitData(data)) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    const tgId = data.id;

    // сохраняем / обновляем пользователя
    const { error: upsertErr } = await sb.from("users").upsert(
      {
        tg_user_id: tgId,
        username: data.username || null,
        first_name: data.first_name || null,
        last_name: data.last_name || null,
        photo_url: data.photo_url || null,
        lang_code: data.language_code || null,
      },
      { onConflict: "tg_user_id" }
    );

    if (upsertErr) {
      console.error("Supabase upsert error:", upsertErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    const sessionPayload = {
      uid: tgId,
      username: data.username || null,
      first_name: data.first_name || null,
    };

    const cookieVal = signSession(sessionPayload);

    // host-only cookie для домена API
    res.setHeader(
      "Set-Cookie",
      `cm_session=${cookieVal}; Path=/; HttpOnly; SameSite=None; Max-Age=2592000; Secure`
    );

    // РЕДИРЕКТИМ НА /lk С ТОКЕНОМ В QUERY (?cm_token=...)
    const url = new URL(LK_URL);
    url.searchParams.set("cm_token", cookieVal);

    res.writeHead(302, { Location: url.toString() });
    res.end();
  } catch (e) {
    console.error("web-login error:", e);
    res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
