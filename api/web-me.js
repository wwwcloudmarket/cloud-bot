// api/web-me.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

const WEB_JWT_SECRET = process.env.WEB_JWT_SECRET;
const TILDA_ORIGIN = process.env.TILDA_ORIGIN || "https://wwwcloudmarket.ru";

// ——— простая валидация подписанной сессии (cm_session)
function verifySession(cookieVal) {
  if (!cookieVal || !WEB_JWT_SECRET) return null;

  const [json, sig] = cookieVal.split(".");
  if (!json || !sig) return null;

  const check = crypto
    .createHmac("sha256", WEB_JWT_SECRET)
    .update(json)
    .digest("base64url");

  if (sig !== check) return null;

  try {
    return JSON.parse(Buffer.from(json, "base64url").toString());
  } catch {
    return null;
  }
}

// ——— CORS для сайта/приложения
function cors(req, res) {
  const originHeader = req.headers.origin;
  const origin =
    originHeader && originHeader.startsWith("http")
      ? originHeader
      : TILDA_ORIGIN;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export default async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  try {
    if (!WEB_JWT_SECRET) {
      console.error("WEB_JWT_SECRET is not set");
      return res
        .status(500)
        .json({ ok: false, error: "server misconfigured" });
    }

    // достаём cm_session из Cookie без пакета 'cookie'
    const rawCookie = req.headers.cookie || "";
    const m = rawCookie.match(/(?:^|;\s*)cm_session=([^;]+)/);
    const token = m ? m[1] : null;

    const sess = verifySession(token);

    // если не авторизован — отдаем 401
    if (!sess?.uid) {
      return res.status(401).json({ ok: false });
    }

    // профиль пользователя
    const { data: user, error: userErr } = await sb
      .from("users")
      .select("tg_user_id, first_name, username, phone, photo_url")
      .eq("tg_user_id", sess.uid)
      .single();

    if (userErr || !user) {
      return res.status(401).json({ ok: false });
    }

    // победы/история — адаптируй под свои реальные таблицы
    const { data: wins = [], error: winsErr } = await sb
      .from("winners")
      .select("raffle_id, decided_at")
      .eq("tg_user_id", sess.uid)
      .order("decided_at", { ascending: false });

    if (winsErr) {
      console.error("winners query error:", winsErr);
    }

    // здесь можно подтянуть покупки, участие и т.п. по другим таблицам
    return res.json({
      ok: true,
      user: {
        ...user,
        wins: wins || [],
        purchases: [], // заглушка, если пока нет
      },
    });
  } catch (e) {
    console.error("web-me error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
