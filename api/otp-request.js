// api/otp-request.js
import { sb } from "../lib/db.js";          // твой уже настроенный Supabase клиент
import { normalizePhone } from "../lib/phone.js";

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm) return res.status(400).json({ ok: false, error: "invalid phone" });

    // генерим код: 4–6 цифр (здесь 4)
    const code = String(Math.floor(1000 + Math.random() * 9000));

    // сохраняем
    const { error: insErr } = await sb
      .from("otp_codes")
      .insert({
        phone_raw: phoneRaw,
        phone_norm: phoneNorm,
        code,
      });

    if (insErr) {
      console.error("otp-request insert error:", insErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    // TODO: отправка кода через твоего Telegram-бота
    // await sendViaTelegram(phoneNorm, code)

    console.log(`OTP sent to ${phoneNorm}: ${code}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("otp-request error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
