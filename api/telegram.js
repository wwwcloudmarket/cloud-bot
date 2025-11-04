import { Telegraf, Markup } from "telegraf";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

// ===== Helpers =====
function mainMenu() {
  return Markup.keyboard([["👤 Мой профиль", "🎯 Рафлы"], ["⚙️ Настройки"]]).resize();
}
function phoneKeyboard() {
  return Markup.keyboard([[{ text: "📱 Поделиться номером", request_contact: true }]])
    .oneTime()
    .resize();
}
function maskPhone(p) {
  if (!p) return "—";
  // +7 999 *** ** 11
  const digits = p.replace(/[^\d+]/g, "");
  if (digits.length < 6) return digits;
  return digits.slice(0, 3) + " " + digits.slice(3, 6) + " *** ** " + digits.slice(-2);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}
function html(s) {
  return s?.replace?.(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) ?? s;
}
function parseDateToISO(s) {
  const t = s.trim().replace(" ", "T") + ":00.000Z";
  return new Date(t).toISOString();
}

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

// ===== Public =====
bot.start(async (ctx) => {
  await saveUser(ctx);

  // если телефона нет — попросим контакт
  const { data: user } = await sb
    .from("users")
    .select("phone")
    .eq("tg_user_id", ctx.from.id)
    .single();

  if (!user?.phone) {
    await ctx.reply(
      "Для подтверждения аккаунта поделись номером телефона (кнопка ниже) 👇",
      phoneKeyboard()
    );
  } else {
    await ctx.reply("Добро пожаловать в Cloud Market 🎯\nВыбери пункт меню ниже:", mainMenu());
  }
});

// принимаем контакт и сохраняем телефон
bot.on("contact", async (ctx) => {
  try {
    const contact = ctx.message?.contact;
    if (!contact || String(contact.user_id) !== String(ctx.from.id)) {
      // игнорируем контакты не владельца
      return ctx.reply("Можно поделиться только своим номером 😊", phoneKeyboard());
    }

    // сохраняем номер (+7999...)
    const phone = contact.phone_number.startsWith("+")
      ? contact.phone_number
      : "+" + contact.phone_number;

    await sb
      .from("users")
      .update({ phone })
      .eq("tg_user_id", ctx.from.id);

    await ctx.reply("Спасибо! Телефон сохранён ✅", mainMenu());
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось сохранить номер. Попробуй ещё раз.", phoneKeyboard());
  }
});

// Мой профиль
bot.hears("👤 Мой профиль", async (ctx) => {
  await saveUser(ctx);
  const id = ctx.from.id;

  const { data: user } = await sb
    .from("users")
    .select("tg_user_id, first_name, username, phone")
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
    `Имя: ${html(user.first_name || "—")}`,
    `Username: @${user.username || "—"}`,
    `Телефон: ${maskPhone(user.phone)}`,
    ``,
    `<b>🏆 Победы:</b>`,
    wins?.length
      ? wins
          .map(
            (e, i) =>
              `${i + 1}. ${e.raffle_id.slice(0, 8)}... — ${new Date(e.decided_at).toLocaleString()}`
          )
          .join("\n")
      : "Пока нет побед 😔",
  ].join("\n");

  // если телефона нет — напомним добавить
  if (!user?.phone) {
    await ctx.reply(
      "Добавь телефон, чтобы мы могли связаться, если ты победишь:",
      phoneKeyboard()
    );
  }
  return ctx.reply(text, { parse_mode: "HTML", ...mainMenu() });
});

// Рафлы (как раньше)
bot.hears("🎯 Рафлы", async (ctx) => {
  const { data: raffles } = await sb
    .from("raffles")
    .select("*")
    .eq("is_finished", false)
    .order("starts_at", { ascending: true });

  if (!raffles || raffles.length === 0) {
    return ctx.reply("❌ Сейчас нет активных дропов.", mainMenu());
  }

  for (const r of raffles) {
    const text = `🎯 <b>${html(r.title)}</b>\n\nКто первый нажмёт — тот победит 🏆\nПобедителей: ${r.winners_count}`;
    const button = Markup.inlineKeyboard([[Markup.button.callback("🪩 Участвовать", `join_${r.id}`)]]);
    if (r.image_url) {
      await ctx.replyWithPhoto(r.image_url, { caption: text, parse_mode: "HTML", ...button });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...button });
    }
  }
});

// Настройки — кнопка для повторного запроса телефона
bot.hears("⚙️ Настройки", async (ctx) => {
  await ctx.reply("Если нужно обновить номер — нажми кнопку ниже 👇", phoneKeyboard());
  return ctx.reply("Настройки:\n— язык: auto\n— уведомления: включены 🔔", mainMenu());
});

// Участие (мульти-победители — как раньше)
bot.action(/join_(.+)/, async (ctx) => {
  const raffleId = ctx.match[1];
  const user = ctx.from;

  try {
    const { data: raffle } = await sb.from("raffles").select("*").eq("id", raffleId).single();
    if (!raffle) return ctx.answerCbQuery("Раффл не найден 😔");

    if (raffle.is_finished) {
      await ctx.answerCbQuery("❌ Дроп завершён!");
      return ctx.reply("❌ Дроп уже закрыт!");
    }

    const { data: existing } = await sb.from("winners").select("id").eq("raffle_id", raffleId);
    const count = existing?.length || 0;
    if (count >= raffle.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);
      return ctx.answerCbQuery("Все победители уже выбраны 😅");
    }

    const { data: prev } = await sb
      .from("entries")
      .select("id")
      .eq("raffle_id", raffleId)
      .eq("tg_user_id", user.id)
      .maybeSingle();
    if (prev) return ctx.answerCbQuery("Ты уже участвуешь 😎");

    await sb.from("entries").insert({
      raffle_id: raffleId,
      tg_user_id: user.id,
      tg_username: user.username || null,
    });

    await sb.from("winners").insert({ raffle_id: raffleId, tg_user_id: user.id });

    await ctx.answerCbQuery("🎉 Ты выиграл!");
    await ctx.reply(
      `🏆 Поздравляем, ${html(user.first_name || "участник")}!\nТы стал победителем дропа <b>${html(
        raffle.title
      )}</b> 🎯`,
      { parse_mode: "HTML" }
    );

    const { data: allWinners } = await sb.from("winners").select("tg_user_id").eq("raffle_id", raffleId);
    if ((allWinners?.length || 0) >= raffle.winners_count) {
      await sb.from("raffles").update({ is_finished: true }).eq("id", raffleId);

      if (process.env.CHAT_ID) {
        await bot.telegram.sendMessage(
          process.env.CHAT_ID,
          `🎯 Дроп <b>${html(raffle.title)}</b> завершён!\nПобедителей: ${raffle.winners_count}`,
          { parse_mode: "HTML" }
        );
      }
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("Ошибка 😔");
  }
});

// ===== Admin (без изменений основного функционала) =====
const ADMIN_IDS_RAW = ADMIN_IDS.length ? `\n\nАдмины: ${ADMIN_IDS.join(", ")}` : "";

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text =
    "👑 <b>Админ-меню</b>\n\n" +
    "• Создать дроп:\n" +
    "<code>/adddrop Название | 2025-11-05 18:00 | 2 | https://.../image.jpg</code>\n" +
    "image_url — опционально\n\n" +
    "• Завершить дроп вручную:\n" +
    "<code>/finish &lt;raffle_uuid&gt;</code>" +
    ADMIN_IDS_RAW;
  await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("adddrop", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const raw = ctx.message.text.replace(/^\/adddrop\s*/i, "");
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 3) {
    return ctx.reply(
      "Формат:\n/adddrop Название | 2025-11-05 18:00 | 2 | https://.../image.jpg (опционально)"
    );
  }
  const [title, starts, winnersCountStr, imageUrl] = parts;
  const winners_count = parseInt(winnersCountStr, 10) || 1;

  try {
    const starts_at = parseDateToISO(starts);
    const insert = {
      title,
      starts_at,
      winners_count,
      created_by: ctx.from.id,
      status: "scheduled",
      is_finished: false,
    };
    if (imageUrl) insert.image_url = imageUrl;

    const { data, error } = await sb.from("raffles").insert(insert).select("id").single();
    if (error) throw error;

    await ctx.reply(
      `✅ Дроп создан:\n<b>${html(title)}</b>\nСтарт: ${starts}\nПобедителей: ${winners_count}\nID: <code>${data.id}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("Ошибка при создании дропа. Проверь формат и время.");
  }
});

bot.command("finish", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = (ctx.message.text.split(" ").slice(1).join(" ") || "").trim();
  if (!id) return ctx.reply("Укажи ID: /finish <raffle_uuid>");
  try {
    await sb.from("raffles").update({ is_finished: true }).eq("id", id);
    await ctx.reply(`✅ Дроп ${id} помечен завершённым`);
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось завершить дроп");
  }
});

// ===== Vercel webhook handler =====
export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    await bot.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Bot error:", e);
    return res.status(200).json({ ok: true });
  }
}
