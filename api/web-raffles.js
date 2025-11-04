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
  const check = crypto.createHmac("sha256", process.env.WEB_JWT_SECRET).update(json).digest("base64url");
  if (sig !== check) return null;
  try { return JSON.parse(Buffer.from(json, "base64url").toString()); } catch { return null; }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const cookies = parse(req.headers.cookie || "");
    const sess = verifySession(cookies.cm_session);
    if (!sess) return res.status(401).json({ ok: false });

    if (req.method === "GET") {
      // активные дропы
      const { data: raffles } = await sb
        .from("raffles")
        .select("id, title, image_url, winners_count, is_finished, starts_at")
        .eq("is_finished", false)
        .order("starts_at", { ascending: true });

      return res.json({ ok: true, raffles: raffles || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const raffleId = body?.raffleId;
      if (!raffleId) return res.status(400).json({ ok: false, error: "missing raffleId" });

      const userId = sess.uid;

      // получаем раффл
      const { data: raffle } = await sb.from("raffles").select("*").eq("id", raffleId).single();
      if (!raffle) return res.status(404).json({ ok: false, error: "raffle not found" });
      if (raffle.is_finished) return res.status(400).json({ ok: false, error: "raffle finished" });

      // текущее число победителей
      const { data: winners } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
      if ((winners?.length || 0) >= raffle.winners_count) {
        await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
        return res.status(400).json({ ok: false, error: "winners limit reached" });
      }

      // уже участвовал?
      const { data: prev } = await sb
        .from("entries")
        .select("id")
        .eq("raffle_id", raffleId)
        .eq("tg_user_id", userId)
        .maybeSingle();
      if (prev) return res.json({ ok: true, message: "already in" });

      // участие
      await sb.from("entries").insert({
        raffle_id: raffleId,
        tg_user_id: userId,
      });

      // победитель (механика «кто успел»)
      await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: userId });

      // закрываем при достижении лимита
      const { data: allWinners } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
      if ((allWinners?.length || 0) >= raffle.winners_count) {
        await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      }

      return res.json({ ok: true, message: "joined and won" });
    }

    return res.status(405).json({ ok: false });
  } catch (e) {
    console.error("web-raffles error:", e);
    return res.status(500).json({ ok: false });
  }
}

export const config = { api: { bodyParser: true } };
