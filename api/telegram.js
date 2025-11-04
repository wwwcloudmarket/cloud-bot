import { Telegraf, Markup } from "telegraf";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

function mainMenu() {
  return Markup.keyboard([
    ["👤 Мой профиль", "🎯 Рафлы"],
    ["⚙️ Настройки"],
  ]).resize();
}

// 📍 сохраняем/обновляем пользователя
async function saveUser(ctx) {
  const u = ctx.from;
  if (!u) return;
  await sb.from("users").upsert({
    tg_user_id: u.id,
    username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    lang_code: u.language_code || null,
  });
}

// 🚀 команда /start
bot.start(async (ctx) => {
  await saveUser(ctx);
  await ctx.reply(
    "Добро пожаловать в Cloud Market 🎯\nВыбери пункт меню ниже:",
    mainMenu()
  );
});

// 👤 мой профиль
bot.hears("👤 Мой профиль", async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;

  const { data: user } = await sb
    .from("users")
    .select("*")
    .eq("tg_user_id", id)
    .single();

  const { data: wins } = await sb
    .from("winners")
    .select("raffle_id, decided_at")
    .eq("tg_user_id", id)
    .order("decided_at", { ascending: false });

  const text = [
    `<b>👤 Профиль</b>`,
    `ID: <code>${user.tg_user_id}</code>`,
    `Имя: ${user.first_name || "—"}`,
    `Username: @${user.username || "—"}`,
    ``,
    `<b>🏆 Победы:</b>`,
    wins?.length
      ? wins
          .map(
            (e, i) =>
              `${i + 1}. ${e.raffle_id.slice(0, 8)}... — ${new Date(
                e.decided_at
              ).toLocaleString()}`
          )
          .join("\n")
      : "Пока нет побед 😔",
  ].join("\n");

  return ctx.reply(text, { parse_mode: "HTML", ...mainMenu() });
});

// 🎯 показать активные рафлы
bot.hears("🎯 Рафлы", async (ctx) => {
  const { data: raffles } = await sb
    .from("raffles")
    .select("*")
    .eq("is_finished", false)
    .order("starts_at", { ascending: true });

  if (!raffles || raffles.length === 0)
    return ctx.reply("❌ Сейчас нет активных дропов.", mainMenu());

  for (const r of raffles) {
    const text = `🎯 <b>${r.title}</b>\n📅 Старт: ${new Date(
      r.starts_at
    ).toLocaleString()}\n\nКто первый нажмёт — тот победит 🏆`;
    const button = Markup.inlineKeyboard([
      [Markup.button.callback("🪩 Участвовать", `join_${r.id}`)],
    ]);
    await ctx.reply(text, { parse_mode: "HTML", ...button });
  }
});

// ⚙️ настройки
bot.hears("⚙️ Настройки", async (ctx) => {
  return ctx.reply(
    "Настройки пока простые:\n— язык: auto\n— уведомления: включены 🔔",
    mainMenu()
  );
});

// 🪩 участие (кто первый — тот победил)
bot.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;

  try {
    // Проверяем, есть ли уже победитель
    const { data: raffle } = await sb
      .from("raffles")
      .select("*")
      .eq("id", raffleId)
      .single();

    if (!raffle) return ctx.answerCbQuery("Раффл не найден 😔");

    if (raffle.is_finished) {
      await ctx.answerCbQuery("Поздно 😅");
      return ctx.reply("❌ Дроп уже завершён! Победитель определён.");
    }

    // Добавляем участника
    await sb.from("entries").insert({
      raffle_id: raffleId,
      tg_user_id: user.id,
      tg_username: user.username || null,
    });

    // Первый участник — победитель 🎯
    await sb
      .from("raffles")
      .update({ winner_id: user.id, is_finished: true })
      .eq("id", raffleId);

    await sb.from("winners").insert({
      raffle_id: raffleId,
      tg_user_id: user.id,
    });

    await ctx.answerCbQuery("🎉 Ты выиграл!");
    await ctx.reply(
      `🏆 Поздравляем, ${user.first_name || "участник"}!\nТы выиграл в дропе <b>${raffle.title}</b> 🎯`,
      { parse_mode: "HTML" }
    );

    // оповещение в канал (если есть CHAT_ID)
    if (process.env.CHAT_ID) {
      await bot.telegram.sendMessage(
        process.env.CHAT_ID,
        `🏆 Победитель дропа <b>${raffle.title}</b> — ${user.first_name || "участник"} (@${user.username || "no username"})`,
        { parse_mode: "HTML" }
      );
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка 😔");
  }
});

// webhook для Vercel
export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET)
      return res.status(401).json({ ok: false });

    await bot.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Bot error:", e);
    return res.status(200).json({ ok: true });
  }
}
