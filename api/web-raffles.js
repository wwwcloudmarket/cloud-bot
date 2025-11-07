// api/web-raffles.js
import { sb } from "../lib/db.js";
import { parse } from "cookie";
import crypto from "node:crypto";

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function verifySession(cookieVal) {
  if (!cookieVal) return null;
  const [json, sig] = cookieVal.split(".");
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // ✅ Сессия (по куке)
    const cookies = parse(req.headers.cookie || "");
    const sess = verifySession(cookies.cm_session);

    // если пользователь не авторизован — всё равно можно показывать дропы
    const userId = sess?.uid || null;

    if (req.method === "GET") {
      // ⚙️ Берём все активные раффлы
      const { data: raffles, error } = await sb
        .from("raffles")
        .select("id, title, image_url, winners_count, is_finished, starts_at")
        .eq("is_finished", false)
        .order("starts_at", { ascending: true });

      if (error) {
        console.error("Supabase error:", error);
        return res.status(500).json({ ok: false, error: "db error" });
      }

      // ✅ Возвращаем правильный JSON
      return res.json({ ok: true, raffles: raffles || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const raffleId = body?.raffleId;
      if (!raffleId) return res.status(400).json({ ok: false, error: "missing raffleId" });
      if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

      // Берём раффл
      const { data: raffle } = await sb.from("raffles").select("*").eq("id", raffleId).single();
      if (!raffle) return res.status(404).json({ ok: false, error: "raffle not found" });
      if (raffle.is_finished) return res.status(400).json({ ok: false, error: "raffle finished" });

      // Проверяем, участвовал ли пользователь
      const { data: prev } = await sb
        .from("entries")
        .select("id")
        .eq("raffle_id", raffleId)
        .eq("tg_user_id", userId)
        .maybeSingle();
      if (prev) return res.json({ ok: true, message: "already in" });

      // Записываем участие
      await sb.from("entries").insert({
        raffle_id: raffleId,
        tg_user_id: userId,
      });

      // Победитель (первый нажатие)
      await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: userId });

      return res.json({ ok: true, message: "joined and won" });
    }

    return res.status(405).json({ ok: false, error: "method not allowed" });
  } catch (e) {
    console.error("web-raffles error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export const config = { api: { bodyParser: true } };
