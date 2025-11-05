import { sb } from "../lib/db.js";
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  try {
    // Безопасность
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Invalid secret" });
    }

    const now = new Date().toISOString();

    // Выбираем дропы, которые должны стартовать
    const { data: raffles, error } = await sb
      .from("raffles")
      .select("*")
      .eq("status", "scheduled")
      .lte("starts_at", now);

    if (error) throw error;
    if (!raffles?.length) {
      console.log("⏰ Нет новых дропов");
      return res.json({ ok: true, message: "Нет новых дропов" });
    }

    console.log(`🎁 Отправляем ${raffles.length} новых дропов`);

    for (const r of raffles) {
      const caption = `🎯 <b>${r.title}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;

      try {
        if (r.image_url) {
          await bot.telegram.sendPhoto(process.env.CHAT_ID, r.image_url, {
            caption,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "🪩 Участвовать", callback_data: `join_${r.id}` }]],
            },
          });
        } else {
          await bot.telegram.sendMessage(process.env.CHAT_ID, caption, {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[{ text: "🪩 Участвовать", callback_data: `join_${r.id}` }]],
            },
          });
        }

        await sb.from("raffles").update({ status: "active" }).eq("id", r.id);
        console.log(`✅ Рафл ${r.title} отправлен`);
      } catch (err) {
        console.error(`Ошибка отправки ${r.title}:`, err.message);
      }
    }

    res.json({ ok: true, sent: raffles.length });
  } catch (e) {
    console.error("Scheduler error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
