import { sb } from "../lib/db.js";
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Invalid secret" });
    }

    // === 🕒 Исправляем время на локальное (МСК) ===
    const now = new Date();
    const offsetMinutes = now.getTimezoneOffset(); // в минутах (для Москвы: -180)
    const nowLocal = new Date(now.getTime() - offsetMinutes * 60 * 1000).toISOString();
    console.log("⏰ Local time:", nowLocal);

    // === 🧩 Проверяем дропы по локальному времени ===
    const { data: raffles, error } = await sb
      .from("raffles")
      .select("*")
      .eq("status", "scheduled")
      .lte("starts_at", nowLocal);

    if (error) throw error;
    if (!raffles?.length) {
      console.log("⏰ Нет новых дропов");
      return res.json({ ok: true, message: "Нет новых дропов" });
    }

    console.log(`🎁 Найдено ${raffles.length} новых дропов`);

    for (const r of raffles) {
      const caption = `🎯 <b>${r.title}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;

      try {
        if (r.image_url) {
          await bot.telegram.sendPhoto(process.env.CHAT_ID, r.image_url, {
            caption,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🪩 Участвовать", callback_data: `join_${r.id}` }],
              ],
            },
          });
        } else {
          await bot.telegram.sendMessage(process.env.CHAT_ID, caption, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🪩 Участвовать", callback_data: `join_${r.id}` }],
              ],
            },
          });
        }

        await sb.from("raffles").update({ status: "active" }).eq("id", r.id);
        console.log(`✅ Рафл "${r.title}" отправлен`);
      } catch (e) {
        console.error("❌ Ошибка при отправке:", e.message);
      }
    }

    res.json({ ok: true, sent: raffles.length });
  } catch (e) {
    console.error("Scheduler error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
