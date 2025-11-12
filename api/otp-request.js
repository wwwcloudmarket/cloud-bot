// api/otp-request.js
import { sb } from "../lib/db.js";
import { normalizePhone } from "../lib/phone.js";
import crypto from "node:crypto";

function cors(res) {
  const origin = process.env.TILDA_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

// простая SHA-256
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Telegram send via Bot API
async function sendTelegramCode(chatId, code) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: `🔐 Ваш код для входа: *${code}*\n\nКод действителен 10 минут.`,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${resp.status} ${txt}`);
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const phoneRaw = (body?.phone || "").trim();
    const phoneNorm = normalizePhone(phoneRaw);
    if (!phoneNorm) return res.status(400).json({ ok: false, error: "invalid phone" });

    // 1) генерируем код и производные
    const code = String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры
    const code_hash = sha256(code);
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 минут

    // 2) пишем в otp_codes (таблица с колонками: id, code_hash, expires_at, phone, phone_norm, phone_raw, used)
    const { error: insErr } = await sb
      .from("otp_codes")
      .insert({
        phone: phoneNorm,        // если у тебя NOT NULL — заполняем
        phone_raw: phoneRaw,
        phone_norm: phoneNorm,
        code_hash,               // мы храним только хэш
        expires_at,              // обязательное поле, если NOT NULL
        used: false
      });

    if (insErr) {
      console.error("otp-request insert error:", insErr);
      return res.status(500).json({ ok: false, error: "db error" });
    }

    // 3) ищем у пользователя tg_user_id, чтобы отправить код в Telegram
    const { data: users, error: userErr } = await sb
      .from("users") // или "profiles" — подставь свою таблицу профилей
      .select("tg_user_id")
      .eq("phone", phoneNorm)
      .limit(1);

    if (userErr) {
      console.error("otp-request users select error:", userErr);
      // не падаем: просто не отправим в ТГ
    }

    const chatId = users?.[0]?.tg_user_id;

    // 4) отправляем в ТГ, если chatId известен
    if (chatId) {
      try {
        await sendTelegramCode(chatId, code);
      } catch (e) {
        console.error("telegram send error:", e);
        // не падаем, код в БД есть — можно ввести вручную из логов при отладке
      }
    } else {
      console.log(`No tg_user_id for ${phoneNorm}. Ask user to /start the bot.`);
    }

    // 5) для отладки можно временно логировать код на сервере
    console.log(`OTP sent to ${phoneNorm}: ${code}`);

    return res.json({ ok: true });
  } catch (e) {
    console.error("otp-request error:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
}

export const config = { api: { bodyParser: true } };
