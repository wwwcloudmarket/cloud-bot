import { Telegraf, Markup } from 'telegraf';
import { sb } from '../lib/db.js';

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

function mainMenu() {
  return Markup.keyboard([
    ['👤 Мой профиль', '🎯 Рафлы'],
    ['⚙️ Настройки']
  ]).resize();
}

async function saveUser(ctx) {
  const u = ctx.from;
  if (!u) return;
  await sb.from('users').upsert({
    tg_user_id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    lang_code: u.language_code || null
  });
}

// Команда /start
bot.start(async (ctx) => {
  await saveUser(ctx);
  return ctx.reply(
    'Добро пожаловать в Cloud Market 🎯\nВыбери пункт меню ниже:',
    mainMenu()
  );
});

// Мой профиль
bot.hears('👤 Мой профиль', async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;

  const { data: user } = await sb.from('users')
    .select('*')
    .eq('tg_user_id', id)
    .single();

  const { data: entries } = await sb.from('entries')
    .select('raffle_id, created_at')
    .eq('tg_user_id', id)
    .order('created_at', { ascending: false })
    .limit(5);

  const text = [
    `<b>👤 Профиль</b>`,
    `ID: <code>${user.tg_user_id}</code>`,
    `Имя: ${user.first_name || '—'}`,
    `Username: @${user.username || '—'}`,
    ``,
    `<b>🎟 Последние участия:</b>`,
    entries?.length
      ? entries.map((e, i) => `${i + 1}. ${e.raffle_id.slice(0, 8)}... — ${new Date(e.created_at).toLocaleString()}`).join('\n')
      : 'Нет участий'
  ].join('\n');

  return ctx.reply(text, { parse_mode: 'HTML', ...mainMenu() });
});

// Кнопка "Рафлы" — показываем активные
bot.hears('🎯 Рафлы', async (ctx) => {
  const now = new Date().toISOString();
  const { data: raffles } = await sb.from('raffles')
    .select('*')
    .gt('ends_at', now)
    .order('starts_at', { ascending: true });

  if (!raffles || raffles.length === 0)
    return ctx.reply('❌ Сейчас нет активных дропов.', mainMenu());

  for (const r of raffles) {
    const text = `🎯 <b>${r.title}</b>\n📅 ${new Date(r.ends_at).toLocaleString()}\nНаграды: ${r.winners_count}`;
    const button = Markup.inlineKeyboard([
      [Markup.button.callback('🪩 Участвовать', `join_${r.id}`)]
    ]);
    await ctx.reply(text, { parse_mode: 'HTML', ...button });
  }
});

// Обработка участия
bot.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;
  try {
    await sb.from('entries').upsert({
      raffle_id: raffleId,
      tg_user_id: user.id,
      tg_username: user.username || null
    });
    await ctx.answerCbQuery('✅ Ты участвуешь!');
  } catch (e) {
    await ctx.answerCbQuery('Ошибка участия 😔');
  }
});

// Настройки
bot.hears('⚙️ Настройки', async (ctx) => {
  return ctx.reply('Настройки пока простые:\n— язык: auto\n— уведомления: включены 🔔', mainMenu());
});

// Webhook обработчик для Vercel
export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    await bot.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error('Bot error:', e);
    return res.status(200).json({ ok: true });
  }
}
