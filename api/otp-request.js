import { sb } from "../lib/db.js";
import { Telegraf } from "telegraf";
import { normalizePhone, randomCode6, hashCode } from "../lib/util.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- CORS для iOS / Safari ---
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const p = normalizePhone(body?.phone || "");
    if (!p) return res.status(400).json({ ok: false, error: "phone_required" });

    // ищем пользователя по телефону
    const { data: user } = await sb
      .from("users")
      .select("tg_user_id, first_name, username, phone")
      .eq("phone", p)
      .maybeSingle();

    if (!user?.tg_user_id) {
      return res.status(404).json({ ok: false, error: "phone_not_found" });
    }

    // генерим код и сохраняем
    const code = randomCode6();
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    await sb.from("otp_codes").insert({
      phone: p.toLowerCase(),
      code_hash: hashCode(code),
      expires_at: expires,
    });

    // отправляем код в Telegram
    await bot.telegram.sendMessage(
      user.tg_user_id,
      `🔐 Код для входа в Cloud Market: <b>${code}</b>\nДействует 5 минут.`,
      { parse_mode: "HTML" }
    );

    return res.json({ ok: true, sent: true });
  } catch (e) {
    console.error("otp-request error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
