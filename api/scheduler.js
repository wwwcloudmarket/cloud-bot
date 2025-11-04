import { Telegraf } from "telegraf";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  try {
    const now = new Date().toISOString();

    const { data: raffles } = await sb
      .from("raffles")
      .select("*")
      .eq("status", "scheduled")
      .lte("starts_at", now);

    if (!raffles || raffles.length === 0)
      return res.json({ ok: true, message: "Нет новых дропов" });

    for (const r of raffles) {
      const caption = `🎯 <b>${r.title}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;

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

      await sb
        .from("raffles")
        .update({ status: "active" })
        .eq("id", r.id);
    }

    return res.json({ ok: true, sent: raffles.length });
  } catch (e) {
    console.error("Scheduler error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
