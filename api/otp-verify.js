// api/otp-verify.js
import { sb } from "../lib/db.js";
import { normalizePhone } from "../lib/phone.js";
import crypto from "crypto";

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

// срок жизни OTP (в минутах)
const OTP_TTL_MIN = 10;

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const code = (body?.code || "").trim();

    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm || !code)
      return res.status(400).json({ ok: false, error: "invalid payload" });

    const hash = crypto.createHash("sha256").update(code).digest("hex");

    // выбираем последний неиспользованный код по номеру
    const { data: rows, error: selErr } = await sb
      .from("otp_codes")
      .select("id, code_hash, created_at, used")
      .eq("phone_norm", phoneNorm)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1);

    if (selErr) {
      console.error("otp-verify select error:", selErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    const row = rows?.[0];
    if (!row) return res.status(400).json({ ok: false, error: "code not found" });

    // сравниваем хеши
    if (row.code_hash !== hash)
      return res.status(400).json({ ok: false, error: "wrong code" });

    // проверяем TTL
    const created = new Date(row.created_at).getTime();
    const ageMin = (Date.now() - created) / 60000;
    if (ageMin > OTP_TTL_MIN)
      return res.status(400).json({ ok: false, error: "code expired" });

    // помечаем как использованный
    const { error: updErr } = await sb
      .from("otp_codes")
      .update({ used: true })
      .eq("id", row.id);

    if (updErr) console.error("otp-verify update error:", updErr);

    // ищем пользователя по номеру
    const { data: users } = await sb
      .from("users") // измени на "profiles", если у тебя другая таблица
      .select("tg_user_id, first_name, last_name, username, phone, photo_url")
      .eq("phone", phoneNorm)
      .limit(1);

    const user = users?.[0] || null;

    return res.json({
      ok: true,
      app_token: null,
      user,
    });
  } catch (e) {
    console.error("otp-verify error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
