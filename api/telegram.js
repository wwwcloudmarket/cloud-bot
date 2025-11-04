import { Telegraf, Markup } from 'telegraf';
import { sb } from '../lib/db.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_me_long_random';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');

const bot = new Telegraf(BOT_TOKEN, { telegram: { webhookReply: true } });

function menu() {
  return Markup.keyboard([
    ['👤 Мой профиль', '🎟 Мои рафлы'],
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

bot.start(async (ctx) => {
  await saveUser(ctx);
  await ctx.reply('Добро пожаловать в личный кабинет!', menu());
  await ctx.reply('Выбери пункт ниже 👇');
});

bot.hears('👤 Мой профиль', async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;
  const { data: user } = await sb.from('users').select('*').eq('tg_user_id', id).single();
  const lines = [
    `ID: ${user.tg_user_id}`,
    `Username: ${user.username || '—'}`,
    `Имя: ${user.first_name || '—'} ${user.last_name || ''}`.trim(),
    `Язык: ${user.lang_code || '—'}`,
    `Создан: ${new Date(user.created_at).toLocaleString()}`
  ];
  return ctx.reply(`📇 Профиль\n${lines.join('\n')}`, menu());
});

bot.hears('🎟 Мои рафлы', async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;
  const { data: entries } = await sb
    .from('entries')
    .select('raffle_id, created_at')
    .eq('tg_user_id', id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!entries || entries.length === 0) {
    return ctx.reply('Пока пусто. Участвуй в Mini App — и тут появится история.', menu());
  }

  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.raffle_id} — ${new Date(e.created_at).toLocaleString()}`
  );
  return ctx.reply(`История (последние 10):\n${lines.join('\n')}`, menu());
});

bot.hears('⚙️ Настройки', async (ctx) => {
  await saveUser(ctx);
  return ctx.reply('Пока тут ничего. Скоро добавим уведомления о победах.', menu());
});

bot.on('message', async (ctx) => {
  await saveUser(ctx);
  return ctx.reply('Выбери пункт меню 👇', menu());
});

export default async function handler(req, res) {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ ok: false });

  try {
    await bot.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // отвечаем 200, чтобы Телеграм не спамил ретраями
  }
}
