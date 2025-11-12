import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import { sb } from "../lib/db.js";

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

/* ===================== Helpers / Config ===================== */

const ITEMS_BTN = "🧾 Мои вещи";
const ADD_PROMPT = "Введите 10-значный код с бирки/карточки вещи:";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id || ""));
}

function mainMenu() {
  return Markup.keyboard([
    ["👤 Мой профиль", "🎯 Рафлы"],
    [ITEMS_BTN, "⚙️ Настройки"],
  ]).resize();
}
function phoneKeyboard() {
  return Markup.keyboard([[{ text: "📱 Поделиться номером", request_contact: true }]])
    .oneTime()
    .resize();
}
function maskPhone(p) {
  if (!p) return "—";
  const digits = p.replace(/[^\d+]/g, "");
  if (digits.length < 6) return digits;
  return digits.slice(0, 3) + " " + digits.slice(3, 6) + " *** ** " + digits.slice(-2);
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

/* ===== Коды: хеш/генерация/проверка (Luhn) ===== */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// 10-значный код: 9 случайных + контрольная (Luhn)
function genCode10() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = base[8 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return base.join("") + String(check);
}
function luhnOk(code) {
  if (!/^\d{10}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return ((sum + check) % 10) === 0;
}

// поиск товара по SKU или UUID
async function findProductId(skuOrId) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(skuOrId);
  if (isUuid) return skuOrId;
  const { data, error } = await sb.from("products").select("id").eq("sku", skuOrId).maybeSingle();
  if (error || !data) throw new Error("Товар не найден по SKU: " + skuOrId);
  return data.id;
}

/* ===================== Public ===================== */

// Старт
bot.start(async (ctx) => {
  await saveUser(ctx);

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

// Принимаем контакт и сохраняем телефон
bot.on("contact", async (ctx) => {
  try {
    const contact = ctx.message?.contact;
    if (!contact || String(contact.user_id) !== String(ctx.from.id)) {
      return ctx.reply("Можно поделиться только своим номером 😊", phoneKeyboard());
    }
    const phone = contact.phone_number.startsWith("+")
      ? contact.phone_number
      : "+" + contact.phone_number;

    await sb.from("users").update({ phone }).eq("tg_user_id", ctx.from.id);
    await ctx.reply("Спасибо! Телефон сохранён ✅", mainMenu());
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось сохранить номер. Попробуй ещё раз.", phoneKeyboard());
  }
});

// Профиль
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

  if (!user?.phone) {
    await ctx.reply("Добавь телефон, чтобы мы могли связаться, если ты победишь:", phoneKeyboard());
  }
  return ctx.reply(text, { parse_mode: "HTML", ...mainMenu() });
});

// Мои вещи — список + кнопка «Добавить вещь»
bot.hears(ITEMS_BTN, async (ctx) => {
  try {
    const { data: rows } = await sb
      .from("item_instances")
      .select("id,size,serial,claimed_at,products(title,sku,image_url)")
      .eq("claimed_by_tg_id", ctx.from.id)
      .order("claimed_at", { ascending: false })
      .limit(20);

    const list = (rows?.length)
      ? rows.map(r => {
          const p = r.products || {};
          const name = p.title || p.sku || "Product";
          const when = r.claimed_at ? new Date(r.claimed_at).toLocaleDateString() : "";
          return `• ${name} ${r.size || ""} #${r.serial ?? ""} — ${when}`;
        }).join("\n")
      : "Пока пусто.";

    await ctx.reply(
      `<b>🧾 Мои вещи</b>\n\n${list}\n\nНажми «Добавить вещь», если у тебя есть код.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("➕ Добавить вещь", "ADD_ITEM")]]),
      }
    );
  } catch (e) {
    console.error(e);
    return ctx.reply("Не удалось загрузить список вещей 😔", mainMenu());
  }
});

// Запрос ввода кода
bot.action("ADD_ITEM", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(ADD_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: "Например: 1234567890" },
  });
});

// Обработка ответа с кодом (force reply)
bot.on("text", async (ctx) => {
  const q = ctx.message?.reply_to_message?.text || "";
  if (!q || !q.startsWith(ADD_PROMPT)) return; // не наш ответ

  const raw = (ctx.message.text || "").replace(/\D/g, "");
  if (raw.length !== 10) {
    return ctx.reply("Код должен состоять из 10 цифр. Нажмите «➕ Добавить вещь» и попробуйте ещё раз.");
  }
  if (!luhnOk(raw)) {
    return ctx.reply("Похоже, код введён с ошибкой (контрольная цифра не сходится). Проверьте и попробуйте снова.");
  }

  try {
    const hash = sha256(raw);
    const { error } = await sb.rpc("claim_item_by_code", {
      p_code_hash: hash,
      p_owner: ctx.from.id,
    });

    if (error) {
      return ctx.reply("Код не найден или уже использован. Проверьте цифры и попробуйте снова.");
    }

    await ctx.reply("Готово! Вещь добавлена в «Мои вещи» ✅");
  } catch (e) {
    console.error(e);
    return ctx.reply("Не удалось добавить вещь. Попробуйте позже.");
  }
});

// Рафлы
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

// Участие
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

// Настройки
bot.hears("⚙️ Настройки", async (ctx) => {
  await ctx.reply("Если нужно обновить номер — нажми кнопку ниже 👇", phoneKeyboard());
  return ctx.reply("Настройки:\n— язык: auto\n— уведомления: включены 🔔", mainMenu());
});

/* ===================== Admin ===================== */

const ADMIN_IDS_RAW = ADMIN_IDS.length ? `\n\nАдмины: ${ADMIN_IDS.join(", ")}` : "";

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text =
    "👑 <b>Админ-меню</b>\n\n" +
    "• Создать дроп:\n" +
    "<code>/adddrop Название | 2025-11-05 18:00 | 2 | https://.../image.jpg</code>\n" +
    "image_url — опционально\n\n" +
    "• Завершить дроп вручную:\n" +
    "<code>/finish &lt;raffle_uuid&gt;</code>\n\n" +
    "• Создать вещь с кодом:\n" +
    "<code>/mintcode &lt;SKU|product_id&gt; &lt;SIZE&gt; &lt;SERIAL&gt;</code>\n" +
    "Пример: <code>/mintcode CM-TEE-001 L 1</code>\n\n" +
    "• Партия вещей с кодами:\n" +
    "<code>/mintbatchcode &lt;SKU|product_id&gt; &lt;SIZE&gt; &lt;RANGE&gt;</code>\n" +
    "Примеры: <code>/mintbatchcode CM-TEE-001 L 1..10</code> или <code>1,3,5</code>" +
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

// admin: создать одну вещь с кодом
bot.command("mintcode", async (ctx) => {
  if (!isAdmin(ctx)) return;
  // /mintcode <SKU|product_id> <SIZE> <SERIAL>
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (args.length < 3) {
    return ctx.reply("Формат: /mintcode <SKU|product_id> <SIZE> <SERIAL>\nПример: /mintcode CM-TEE-001 L 1");
  }
  const [skuOrId, size, serialStr] = args;
  const serial = parseInt(serialStr, 10);
  if (!serial) return ctx.reply("Serial должен быть числом");

  try {
    const product_id = await findProductId(skuOrId);
    const code = genCode10();
    const hash = sha256(code);

    const { data: row, error } = await sb
      .from("item_instances")
      .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" })
      .select("id")
      .single();
    if (error) throw error;

    await ctx.reply(
      `✅ Создан экземпляр\nID: <code>${row.id}</code>\n${size} #${serial}\nКОД: <b>${code}</b>\n\nВпишите/напечатайте этот код на бирку.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error(e);
    ctx.reply("Не удалось создать: " + (e.message || "ошибка"));
  }
});

// admin: партия вещей с кодами
bot.command("mintbatchcode", async (ctx) => {
  if (!isAdmin(ctx)) return;
  // /mintbatchcode <SKU|product_id> <SIZE> <RANGE> (1..20 или 1,2,5)
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (args.length < 3) {
    return ctx.reply(
      "Формат: /mintbatchcode <SKU|product_id> <SIZE> <RANGE>\nПримеры:\n/mintbatchcode CM-TEE-001 L 1..10\n/mintbatchcode CM-TEE-001 M 1,3,5"
    );
  }
  const [skuOrId, size, rangeRaw] = args;
  let serials = [];
  if (/^\d+\.\.\d+$/.test(rangeRaw)) {
    const [a, b] = rangeRaw.split("..").map((n) => parseInt(n, 10));
    for (let i = a; i <= b; i++) serials.push(i);
  } else {
    serials = rangeRaw.split(",").map((n) => parseInt(n.trim(), 10)).filter(Boolean);
  }
  if (!serials.length) return ctx.reply("Пустой диапазон серийников");

  try {
    const product_id = await findProductId(skuOrId);
    const lines = [];
    for (const s of serials) {
      const code = genCode10();
      const hash = sha256(code);
      const { error } = await sb
        .from("item_instances")
        .insert({ product_id, size, serial: s, claim_code_hash: hash, claim_token_hash: "code" });
      if (error) throw error;
      lines.push(`${size} #${s} — ${code}`);
    }

    const text =
      `✅ Партия создана (${lines.length} шт.)\n` +
      `Товар: ${skuOrId} / размер: ${size}\n\n` +
      lines.join("\n");
    for (let i = 0; i < text.length; i += 3500) {
      await ctx.reply(text.slice(i, i + 3500));
    }
  } catch (e) {
    console.error(e);
    ctx.reply("Не удалось создать партию: " + (e.message || "ошибка"));
  }
});

/* ===================== Vercel webhook ===================== */

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
