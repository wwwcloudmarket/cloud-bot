// api/web-me.js
import { sb } from "../lib/db.js";
import crypto from "node:crypto";

// ——— простая валидация подписанной сессии (cm_session)
function verifySession(cookieVal) {
  if (!cookieVal) return null;
  const [json, sig] = cookieVal.split(".");
  if (!json || !sig) return null;
  const check = crypto
    .createHmac("sha256", process.env.WEB_JWT_SECRET)
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
function cors(res) {
  // если хочешь ограничить доменом Тильды — подставь origin вместо "*"
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // достаём cm_session из Cookie без пакета 'cookie'
    const rawCookie = req.headers.cookie || "";
    const m = rawCookie.match(/(?:^|;\s*)cm_session=([^;]+)/);
    const token = m ? m[1] : null;

    const sess = verifySession(token);
    if (!sess?.uid) return res.json({ ok: false });

    // тянем профиль из БД
    const { data: user, error } = await sb
      .from("users")
      .select("tg_user_id, first_name, username, phone, photo_url")
      .eq("tg_user_id", sess.uid)
      .single();
    if (error || !user) return res.json({ ok: false });

    // пример: победы/покупки — адаптируй под свои таблицы
    const { data: wins } = await sb
      .from("winners")
      .select("raffle_id, decided_at")
      .eq("tg_user_id", sess.uid)
      .order("decided_at", { ascending: false });

    return res.json({
      ok: true,
      user: {
        ...user,
        wins: wins || [],
        // заглушка покупок, если ещё нет таблицы
        purchases: []
      }
    });
  } catch (e) {
    console.error("web-me error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
