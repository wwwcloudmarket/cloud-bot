import { sb } from "../lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const { phone } = body;

  if (!phone) return res.status(400).json({ ok: false, error: "missing phone" });

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await sb.from("phone_codes").upsert({ phone, code });

  // тут можно подключить реальную SMS API (Twilio / Telegram)
  console.log(`📲 Код для ${phone}: ${code}`);

  return res.json({ ok: true });
}
