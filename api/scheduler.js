import { Telegraf } from "telegraf";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  try {
    const now = new Date().toISOString();

    // Получаем все дропы, которые пора выложить
    const { data: raffles, error } = await sb
      .from("raffles")
      .select("*")
      .eq("status", "scheduled")
      .lte("starts_at", now);

    if (error) throw error;

    if (!raffles || raffles.length === 0) {
      return res.json({ ok: true, message: "Нет новых дропов для публикации." });
    }

    for (const r of raffles) {
      // Отправляем сообщение в чат
      await bot.telegram.sendMessage(
        process.env.CHAT_ID,
        `🎯 <b>${r.title}</b>\n\nКто первый нажмёт — тот победит 🏆`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🪩 Участвовать", callback_data: `join_${r.id}` }],
            ],
          },
        }
      );

      // Обновляем статус дропа
      await sb
        .from("raffles")
        .update({ status: "active" })
        .eq("id", r.id);
    }

    return res.json({ ok: true, sent: raffles.length });
  } catch (e) {
    console.error("Scheduler error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
