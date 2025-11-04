import { Telegraf } from 'telegraf';
import { sb } from '../lib/db.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

export default async function handler(req, res) {
  const now = new Date().toISOString();

  const { data: raffles } = await sb
    .from('raffles')
    .select('*')
    .eq('posted', false)
    .lte('starts_at', now);

  if (!raffles || raffles.length === 0)
    return res.json({ ok: true, message: 'no raffles to post' });

  for (const r of raffles) {
    await bot.telegram.sendMessage(
      process.env.CHAT_ID, // твой Telegram ID или ID канала
      `🎯 <b>${r.title}</b>\n\nНачало: ${new Date(r.starts_at).toLocaleString()}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🪩 Участвовать', callback_data: `join_${r.id}` }]
          ]
        }
      }
    );

    await sb.from('raffles').update({ posted: true }).eq('id', r.id);
  }

  return res.json({ ok: true, sent: raffles.length });
}
