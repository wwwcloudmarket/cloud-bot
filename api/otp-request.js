// api/otp-request.js
import { sb } from "../lib/db.js";
import { normalizePhone } from "../lib/phone.js";
import crypto from "crypto";

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm)
      return res.status(400).json({ ok: false, error: "invalid phone" });

    // генерируем 4-значный код
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const code_hash = crypto.createHash("sha256").update(code).digest("hex");

    // сохраняем код в БД
 // Добавляем срок действия (например, 10 минут)
const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

const { error: insErr } = await sb
  .from("otp_codes")
  .insert({
    phone: phoneNorm,
    phone_raw: phoneRaw,
    phone_norm: phoneNorm,
    code_hash,
    expires_at: expiresAt, // ✅ добавили
  });

    if (insErr) {
      console.error("otp-request insert error:", insErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    // тут можно отправить код через Telegram или SMS
    console.log(`✅ OTP sent to ${phoneNorm}: ${code}`);

    return res.json({ ok: true });
  } catch (e) {
    console.error("otp-request error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
