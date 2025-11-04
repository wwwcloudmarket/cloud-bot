// api/web-me.js
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
  if (req.method !== "GET") return res.status(405).json({ ok: false });

  try {
    const cookies = parse(req.headers.cookie || "");
    const sess = verifySession(cookies.cm_session);
    if (!sess) return res.status(401).json({ ok: false });

    const { data: user } = await sb
      .from("users")
      .select("tg_user_id, username, first_name, phone")
      .eq("tg_user_id", sess.uid)
      .single();

    const { data: wins } = await sb
      .from("winners")
      .select("raffle_id, decided_at")
      .eq("tg_user_id", sess.uid)
      .order("decided_at", { ascending: false });

    return res.json({ ok: true, user, wins });
  } catch (e) {
    console.error("web-me error:", e);
    return res.status(500).json({ ok: false });
  }
}
