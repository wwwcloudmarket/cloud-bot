// api/otp-request.js
import { sb } from "../lib/db.js";
import crypto from "node:crypto";

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, "");
  if (digits.startsWith("8") && digits.length === 11) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  if (!digits.startsWith("7")) digits = "7" + digits;
  return "+" + digits;
}

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm) return res.status(400).json({ ok: false, error: "invalid phone" });

    // 1️⃣ Генерация и хэширование кода
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 минут

    // 2️⃣ Сохраняем код
    const { error: insErr } = await sb
      .from("otp_codes")
      .insert({
        phone: phoneNorm,
        code_hash: codeHash,
        expires_at: expiresAt,
        used: false
      });

    if (insErr) {
      console.error("otp-request insert error:", insErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    // 3️⃣ Ищем Telegram ID
    const { data: users, error: userErr } = await sb
      .from("users")
      .select("tg_user_id")
      .eq("phone", phoneNorm)
      .limit(1);

    if (userErr) console.warn("users lookup error:", userErr);

    const chatId = users?.[0]?.tg_user_id;
    const token = process.env.BOT_TOKEN;

    // 4️⃣ Отправляем код в Telegram
    if (chatId && token) {
      const text = `🔐 Ваш код для входа: *${code}*\nОн действителен 10 минут.`;
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "Markdown"
          })
        });

        if (!resp.ok) {
          const txt = await resp.text();
          console.error("Telegram error:", txt);
        }
      } catch (e) {
        console.error("Telegram send failed:", e);
      }
    } else {
      console.warn("no chatId or BOT_TOKEN; not sending Telegram");
      console.log(`Код для ${phoneNorm}: ${code}`); // ← для теста в логах
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("otp-request error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
