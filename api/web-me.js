// api/web-me.js
import crypto from "node:crypto";
import { sb } from "../lib/db.js";

const WEB_JWT_SECRET = process.env.WEB_JWT_SECRET;
const TILDA_ORIGIN = process.env.TILDA_ORIGIN || "https://wwwcloudmarket.ru";

function verifySession(token) {
  if (!token || !WEB_JWT_SECRET) return null;

  const [json, sig] = token.split(".");
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
    "content-type,authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
}

export default async function handler(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  try {
    if (!WEB_JWT_SECRET) {
      return res
        .status(500)
        .json({ ok: false, error: "server misconfigured" });
    }

    // 1) токен из cookie
    const rawCookie = req.headers.cookie || "";
    const m = rawCookie.match(/(?:^|;\s*)cm_session=([^;]+)/);
    const cookieToken = m ? m[1] : null;

    // 2) токен из Authorization: Bearer xxx
    const authHeader = req.headers.authorization || "";
    const mAuth = authHeader.match(/^Bearer (.+)$/i);
    const headerToken = mAuth ? mAuth[1] : null;

    // 3) токен из query (?cm_token=... | ?token=...)
    const urlToken =
      (req.query && (req.query.cm_token || req.query.token)) || null;

    const token = cookieToken || headerToken || urlToken;
    const sess = verifySession(token);

    if (!sess?.uid) {
      return res.json({ ok: false });
    }

    // 1) Профиль
    const { data: user, error: userErr } = await sb
      .from("users")
      .select(
        "tg_user_id, first_name, last_name, username, phone, city, email, photo_url"
      )
      .eq("tg_user_id", sess.uid)
      .single();

    if (userErr || !user) {
      return res.json({ ok: false });
    }

    // 2) Победы (winners + raffles)
    const { data: wins = [] } = await sb
      .from("winners")
      .select(
        `
        id,
        raffle_id,
        decided_at,
        size,
        raffles!inner(
          title,
          release_code
        )
      `
      )
      .eq("tg_user_id", sess.uid)
      .order("decided_at", { ascending: false });

    const winsMapped = (wins || []).map((w) => ({
      id: w.id,
      raffle_id: w.raffle_id,
      decided_at: w.decided_at,
      size: w.size,
      raffle_title: w.raffles?.title || null,
      release_code: w.raffles?.release_code || null,
    }));

    // 3) Заказы (orders)
    const { data: orders = [] } = await sb
      .from("orders")
      .select(
        "id, order_number, created_at, total_price, currency, title, size"
      )
      .eq("tg_user_id", sess.uid)
      .order("created_at", { ascending: false });

    // 4) Мои вещи
    const { data: items = [] } = await sb
      .from("owned_items")
      .select("id, title, size, color, acquired_at, source, image_url")
      .eq("tg_user_id", sess.uid)
      .order("acquired_at", { ascending: false });

    return res.json({
      ok: true,
      user: {
        ...user,
        wins: winsMapped,
        orders,
        items,
      },
    });
  } catch (e) {
    console.error("web-me error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}
