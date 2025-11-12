import { Telegraf, Markup } from "telegraf";
import crypto from "crypto";
import { sb } from "../lib/db.js";

/** ===================== Helpers / Config ===================== */

const BOT = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: true },
});

const ITEMS_BTN = "🧾 Мои вещи";
const ADD_PROMPT = "Введите 10-значный код с бирки/карточки вещи:";

// Админ-панель (промпты)
const PROMPT_MINT_ONE   = "Введите данные для одной вещи в формате: SKU SIZE SERIAL";
const PROMPT_MINT_BATCH = "Введите данные для партии в формате: SKU SIZE RANGE (например 1..10 или 1,2,5)";
const PROMPT_ADM_ADD    = "Укажите @username или ID и роль (admin|manager) через пробел";
const PROMPT_ADM_DEL    = "Укажите @username или ID для удаления роли";

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

/** ===== Коды: хеш/генерация/проверка (Luhn) ===== */
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

// Поиск product_id по SKU или UUID
async function findProductId(skuOrId) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(skuOrId);
  if (isUuid) return skuOrId;
  const { data, error } = await sb.from("products").select("id").eq("sku", skuOrId).maybeSingle();
  if (error || !data) throw new Error("Товар не найден по SKU: " + skuOrId);
  return data.id;
}

/** ===================== Роли из БД ===================== */

const roleCache = new Map();
async function getRole(tgId) {
  if (roleCache.has(tgId)) return roleCache.get(tgId);
  const { data } = await sb.from("user_roles").select("role").eq("tg_user_id", tgId).maybeSingle();
  const role = data?.role || null;
  roleCache.set(tgId, role);
  return role;
}
async function hasRole(ctx, roles = ["admin"]) {
  const role = await getRole(ctx.from.id);
  return role && roles.includes(role);
}
async function requireRole(ctx, roles = ["admin"]) {
  if (!(await hasRole(ctx, roles))) {
    await ctx.reply("Доступ только для админов.");
    return false;
  }
  return true;
}

/** ===================== Public ===================== */

// /start
BOT.start(async (ctx) => {
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

// контакт
BOT.on("contact", async (ctx) => {
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

// профиль
BOT.hears("👤 Мой профиль", async (ctx) => {
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

// Мои вещи
BOT.hears(ITEMS_BTN, async (ctx) => {
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

// Запрос кода для добавления вещи
BOT.action("ADD_ITEM", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(ADD_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: "Например: 1234567890" },
  });
});

// Force-reply обработчик (и для админ-панели тоже)
BOT.on("text", async (ctx) => {
  const prompt = ctx.message?.reply_to_message?.text || "";
  if (!prompt) return;

  // ===== Пользователь ввёл код вещи
  if (prompt.startsWith(ADD_PROMPT)) {
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
    return;
  }

  // ====== Админ-панель: одна вещь
  if (prompt.startsWith(PROMPT_MINT_ONE)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const [sku, size, serialStr] = (ctx.message.text||"").trim().split(/\s+/);
    const serial = parseInt(serialStr, 10);
    if (!sku || !size || !serial) return ctx.reply("Нужно: SKU SIZE SERIAL (например CM-TEE-001 L 1)");
    try {
      const product_id = await findProductId(sku);
      const code = genCode10();
      const hash = sha256(code);
      const { data: row, error } = await sb
        .from("item_instances")
        .insert({ product_id, size, serial, claim_code_hash: hash, claim_token_hash: "code" })
        .select("id").single();
      if (error) throw error;
      await ctx.reply(`✅ Создано\nID: <code>${row.id}</code>\n${size} #${serial}\nКОД: <b>${code}</b>`, { parse_mode: "HTML" });
    } catch (e) {
      console.error(e); await ctx.reply("Ошибка создания.");
    }
    return;
  }

  // ====== Админ-панель: партия
  if (prompt.startsWith(PROMPT_MINT_BATCH)) {
    if (!(await requireRole(ctx, ["admin","manager"]))) return;
    const [sku, size, rangeRaw] = (ctx.message.text||"").trim().split(/\s+/);
    if (!sku || !size || !rangeRaw) return ctx.reply("Нужно: SKU SIZE RANGE (1..10 или 1,2,5)");
    let serials = [];
    if (/^\d+\.\.\d+$/.test(rangeRaw)) {
      const [a,b] = rangeRaw.split("..").map(n=>parseInt(n,10));
      for (let i=a;i<=b;i++) serials.push(i);
    } else {
      serials = rangeRaw.split(",").map(n=>parseInt(n.trim(),10)).filter(Boolean);
    }
    if (!serials.length) return ctx.reply("Пустой диапазон.");
    try {
      const product_id = await findProductId(sku);
      const lines = [];
      for (const s of serials) {
        const code = genCode10();
        const hash = sha256(code);
        const { error } = await sb.from("item_instances")
          .insert({ product_id, size, serial: s, claim_code_hash: hash, claim_token_hash: "code" });
        if (error) throw error;
        lines.push(`${size} #${s} — ${code}`);
      }
      for (let i=0;i<lines.length;i+=60) {
        await ctx.reply(lines.slice(i,i+60).join("\n"));
      }
      await ctx.reply(`✅ Партия создана: ${serials.length} шт.`);
    } catch (e) {
      console.error(e); await ctx.reply("Ошибка создания партии.");
    }
    return;
  }

  // ====== Админ-панель: роли — добавить
  if (prompt.startsWith(PROMPT_ADM_ADD)) {
    if (!(await requireRole(ctx, ["admin"]))) return;
    const parts = (ctx.message.text||"").trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply("Нужно: @username|ID role");
    const who = parts[0].replace(/^@/,"");
    const role = parts[1];
    if (!["admin","manager"].includes(role)) return ctx.reply("Роль только admin или manager");

    let tgId = /^\d+$/.test(who) ? Number(who) : null;
    if (!tgId) {
      const { data: u } = await sb.from("users").select("tg_user_id").eq("username", who).maybeSingle();
      if (!u) return ctx.reply("Пользователь не найден (он должен хотя бы раз нажать /start).");
      tgId = u.tg_user_id;
    }
    await sb.from("user_roles").upsert({ tg_user_id: tgId, role, added_by: ctx.from.id });
    roleCache.delete(tgId);
    return ctx.reply(`Готово. Назначено: ${who} — ${role}`);
  }

  // ====== Админ-панель: роли — снять
  if (prompt.startsWith(PROMPT_ADM_DEL)) {
    if (!(await requireRole(ctx, ["admin"]))) return;
    const who = (ctx.message.text||"").trim().replace(/^@/,"");
    if (!who) return ctx.reply("Нужно: @username|ID");

    let tgId = /^\d+$/.test(who) ? Number(who) : null;
    if (!tgId) {
      const { data: u } = await sb.from("users").select("tg_user_id").eq("username", who).maybeSingle();
      if (!u) return ctx.reply("Пользователь не найден.");
      tgId = u.tg_user_id;
    }
    await sb.from("user_roles").delete().eq("tg_user_id", tgId);
    roleCache.delete(tgId);
    return ctx.reply(`Роль снята: ${who}`);
  }
});

// Рафлы (список)
BOT.hears("🎯 Рафлы", async (ctx) => {
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
BOT.action(/join_(.+)/, async (ctx) => {
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
        await BOT.telegram.sendMessage(
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
BOT.hears("⚙️ Настройки", async (ctx) => {
  await ctx.reply("Если нужно обновить номер — нажми кнопку ниже 👇", phoneKeyboard());
  return ctx.reply("Настройки:\n— язык: auto\n— уведомления: включены 🔔", mainMenu());
});

/** ===================== Admin Panel (кнопки) ===================== */

BOT.command("admin", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;

  const rows = [
    [ Markup.button.callback("➕ Код для вещи", "ADM_MINT_ONE"),
      Markup.button.callback("📦 Партия кодов", "ADM_MINT_BATCH") ],
    [ Markup.button.callback("🎯 Создать дроп", "ADM_ADD_DROP"),
      Markup.button.callback("✅ Завершить дроп", "ADM_FINISH_DROP") ],
  ];
  if (await hasRole(ctx, ["admin"])) {
    rows.push([
      Markup.button.callback("👑 Роли: добавить", "ADM_ROLE_ADD"),
      Markup.button.callback("🧹 Роли: убрать", "ADM_ROLE_DEL"),
    ]);
    rows.push([Markup.button.callback("📋 Роли: список", "ADM_ROLE_LIST")]);
  }
  await ctx.reply("👑 Админ-панель", Markup.inlineKeyboard(rows));
});

BOT.action("ADM_MINT_ONE", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  return ctx.reply(PROMPT_MINT_ONE, { reply_markup: { force_reply: true, input_field_placeholder: "CM-TEE-001 L 1" }});
});
BOT.action("ADM_MINT_BATCH", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  return ctx.reply(PROMPT_MINT_BATCH, { reply_markup: { force_reply: true, input_field_placeholder: "CM-TEE-001 L 1..10" }});
});
BOT.action("ADM_ADD_DROP", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  await ctx.reply('Скопируйте и заполните:\n/adddrop Название | 2025-11-20 19:00 | 2 | https://.../image.jpg');
});
BOT.action("ADM_FINISH_DROP", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  await ctx.answerCbQuery();
  await ctx.reply('Скопируйте и заполните:\n/finish <raffle_uuid>');
});

// роли (только admin)
BOT.action("ADM_ROLE_ADD", async (ctx) => {
  if (!(await requireRole(ctx, ["admin"]))) return;
  await ctx.answerCbQuery();
  return ctx.reply(PROMPT_ADM_ADD, { reply_markup: { force_reply: true, input_field_placeholder: "@username admin" }});
});
BOT.action("ADM_ROLE_DEL", async (ctx) => {
  if (!(await requireRole(ctx, ["admin"]))) return;
  await ctx.answerCbQuery();
  return ctx.reply(PROMPT_ADM_DEL, { reply_markup: { force_reply: true, input_field_placeholder: "@username" }});
});
BOT.action("ADM_ROLE_LIST", async (ctx) => {
  if (!(await requireRole(ctx, ["admin"]))) return;
  const { data } = await sb.from("user_roles").select("tg_user_id, role, created_at").order("created_at", { ascending: false });
  if (!data?.length) return ctx.reply("Список ролей пуст.");
  const users = await sb.from("users").select("tg_user_id, username, first_name").in("tg_user_id", data.map(x=>x.tg_user_id));
  const byId = new Map((users.data||[]).map(u => [u.tg_user_id, u]));
  const lines = data.map(r => {
    const u = byId.get(r.tg_user_id);
    const nick = u?.username ? "@"+u.username : (u?.first_name || r.tg_user_id);
    return `• ${nick} — ${r.role}`;
  });
  await ctx.reply(`📋 Роли:\n${lines.join("\n")}`);
});

/** ===================== Admin: команды /adddrop /finish ===================== */

BOT.command("adddrop", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
  const raw = ctx.message.text.replace(/^\/adddrop\s*/i, "");
  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length < 3) {
    return ctx.reply(
      "Формат:\n/adddrop Название | 2025-11-20 19:00 | 2 | https://.../image.jpg (опционально)"
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

BOT.command("finish", async (ctx) => {
  if (!(await requireRole(ctx, ["admin","manager"]))) return;
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

/** ===================== Vercel webhook ===================== */

export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
    await BOT.handleUpdate(req.body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Bot error:", e);
    // Всегда 200, чтобы Telegram не ретраил бесконечно
    return res.status(200).json({ ok: true });
  }
}
