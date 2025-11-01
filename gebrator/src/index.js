const { Telegraf, Markup } = require('telegraf');
let proxyAgent = null;
try {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const httpsProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const socksProxy = process.env.SOCKS_PROXY;
  if (socksProxy) {
    proxyAgent = new SocksProxyAgent(socksProxy);
    console.log('[net] Using SOCKS proxy:', socksProxy);
  } else if (httpsProxy) {
    proxyAgent = new HttpsProxyAgent(httpsProxy);
    console.log('[net] Using HTTPS proxy:', httpsProxy);
  }
} catch (e) {
  // optional deps may be missing; skip silently
}
const { getConfig } = require('./config');
const { generateImage } = require('./services/imageGenerator');
const { createRateLimit } = require('./middlewares/rateLimit');
const { createSafety } = require('./middlewares/safety');
const { mainKeyboard, settingsKeyboard } = require('./ui/keyboards');

function main() {
  const cfg = getConfig();
  const bot = proxyAgent ? new Telegraf(cfg.token, { telegram: { agent: proxyAgent } }) : new Telegraf(cfg.token);
  const userPrefs = new Map(); // userId -> { response_format, size }
  const usage = new Map(); // userId -> { plan, used, limit }
  const userMeta = new Map(); // userId -> { joinedAt, wallet }
  const lastJobs = new Map(); // userId -> last job data

  function getUsage(userId) {
    const u = usage.get(userId) || { plan: 'free', used: 0, limit: 20 };
    usage.set(userId, u);
    return u;
  }

  function quotaCheck(ctx) {
    const userId = ctx.from?.id;
    const u = getUsage(userId);
    if (u.plan === 'pro') return true;
    if (u.used >= u.limit) {
      ctx.reply(`پلن: ${u.plan} | مصرف: ${u.used}/${u.limit} در این دوره.\nبرای ارتقا روی «💳 خرید اشتراک» بزن.`);
      return false;
    }
    return true;
  }

  function dimsFromSize(size) {
    if (size === 1080) return { width: 1920, height: 1080 };
    if (size === 720) return { width: 1280, height: 720 };
    if (size === 1024) return { width: 1024, height: 1024 };
    if (size === 768) return { width: 768, height: 768 };
    return { width: 1024, height: 1024 };
  }

  // پشتیبانی از negative_prompt مانند: "پرامپت | negative: متن-منفی" یا "| np: ..."
  function parseUserText(text) {
    const t = String(text || '');
    const m = t.match(/\|\s*(negative|np)\s*:\s*(.+)$/i);
    if (m) {
      const neg = m[2].trim();
      const prompt = t.replace(m[0], '').trim();
      return { prompt, negative: neg };
    }
    return { prompt: t.trim(), negative: undefined };
  }

  function storeLastJob(userId, job) {
    lastJobs.set(userId, job);
  }
  function getLastJob(userId) {
    return lastJobs.get(userId);
  }

  // Middlewares
  bot.use(createRateLimit(cfg));
  bot.use(createSafety(cfg));

  bot.start((ctx) => {
    const userId = ctx.from?.id;
    const meta = userMeta.get(userId) || { joinedAt: new Date(), wallet: 0 };
    userMeta.set(userId, meta);
    ctx.reply(`سلام! من RSIMAGE هستم.\nاز کیبورد پایین استفاده کن یا مستقیم پرامپت بفرست تا عکس بسازم. 🤖🎨`, mainKeyboard());
  });

  bot.help((ctx) => {
    ctx.reply('از کیبورد سریع استفاده کن: 🖼 تولید عکس، ⚙️ تنظیمات، 👤 حساب کاربری، 💳 خرید اشتراک.\nیا مستقیم پرامپت را بفرست.', mainKeyboard());
  });

  // Reply keyboard entries
  bot.hears('🖼 تولید عکس', async (ctx) => {
    await ctx.reply('لطفاً متنِ تصویر موردنظر را ارسال کنید.');
  });

  function getUserPrefs(userId) {
    const p = userPrefs.get(userId) || { response_format: 'url', size: 1080 };
    userPrefs.set(userId, p);
    return p;
  }

  // /img command
  bot.command('img', async (ctx) => {
    const text = ctx.message?.text || '';
    const raw = text.replace(/^\s*\/img\s*/i, '').trim();
    if (!raw) {
      return ctx.reply('لطفاً پرامپت را بعد از دستور /img وارد کنید. مثال: /img یک گربه کیوت');
    }
    const userId = ctx.from?.id;
    const prefs = getUserPrefs(userId);
    if (!quotaCheck(ctx)) return;
    const status = await ctx.reply('در حال ساخت تصویر… ⏳');
    const typing = ctx.replyWithChatAction('upload_photo').catch(() => {});
    try {
      const { prompt: userPrompt, negative } = parseUserText(raw);
      const composed = `${userPrompt}`.trim();
      const dims = dimsFromSize(prefs.size);
      const result = await generateImage(cfg, {
        prompt: composed,
        negative_prompt: negative,
        width: dims.width,
        height: dims.height,
        response_format: prefs.response_format,
      });
      const caption = `✅ آماده شد | مدل: nano-banana`;
      // ترجیح ارسال باینری: اگر base64 موجود است، اول آن را ارسال کن
      if (result.base64) {
        const buf = Buffer.from(result.base64, 'base64');
        await ctx.replyWithPhoto({ source: buf }, { caption });
      } else if (result.url) {
        await ctx.replyWithPhoto(result.url, { caption });
      } else {
        await ctx.reply('پاسخی از سرویس تصویر دریافت نشد. لطفاً دوباره تلاش کنید.');
      }
      const u = getUsage(userId); u.used += 1;
      storeLastJob(userId, { prompt: composed, negative, prefs: { ...prefs }, result });
    } catch (err) {
      const reason = err && err.message ? String(err.message) : 'نامشخص';
      await ctx.reply(`⚠️ خطا در تولید تصویر: ${reason}`);
    } finally {
      try { await ctx.deleteMessage(status.message_id); } catch (_) {}
      await typing;
    }
  });

  // حذف قابلیت‌های غیرضروری (var/up)

  // حذف استایل‌ها؛ فقط تولید عکس ساده

  // /settings
  bot.command('settings', async (ctx) => {
    await ctx.reply('تنظیمات کیفیت را انتخاب کن:', settingsKeyboard());
  });
  bot.hears('⚙️ تنظیمات', async (ctx) => {
    await ctx.reply('تنظیمات کیفیت را انتخاب کن:', settingsKeyboard());
  });
  bot.hears('کیفیت: 1080p', async (ctx) => {
    const prefs = getUserPrefs(ctx.from?.id);
    prefs.size = 1080;
    await ctx.reply(`کیفیت تنظیم شد: 1080p`, mainKeyboard());
  });
  bot.hears('کیفیت: 720p', async (ctx) => {
    const prefs = getUserPrefs(ctx.from?.id);
    prefs.size = 720;
    await ctx.reply(`کیفیت تنظیم شد: 720p`, mainKeyboard());
  });
  // حذف Seed و Guidance
  

  

  

  

  // خرید اشتراک (ارتقا به پلن Pro نامحدود)
  bot.hears('💳 خرید اشتراک', async (ctx) => {
    const u = getUsage(ctx.from?.id);
    u.plan = 'pro';
    u.limit = Infinity;
    await ctx.reply('تبریک! اشتراک شما به پلن Pro ارتقا یافت و محدودیت برداشته شد.', mainKeyboard());
  });

  // حساب کاربری
  bot.hears('👤 حساب کاربری', async (ctx) => {
    const userId = ctx.from?.id;
    const u = getUsage(userId);
    const meta = userMeta.get(userId) || { joinedAt: new Date(), wallet: 0 };
    userMeta.set(userId, meta);
    const now = Date.now();
    const diffMs = now - new Date(meta.joinedAt).getTime();
    const diffDays = Math.floor(diffMs / (24*60*60*1000));
    const diffHours = Math.floor((diffMs % (24*60*60*1000)) / (60*60*1000));
    const joinedStr = new Date(meta.joinedAt).toISOString();
    await ctx.reply(
      `آمار حساب کاربری:\n`+
      `آیدی عددی: ${userId}\n`+
      `مصرف: ${u.used}${u.limit === Infinity ? '/∞' : '/' + u.limit} | پلن: ${u.plan}\n`+
      `تاریخ عضویت: ${joinedStr} (مدت: ${diffDays} روز و ${diffHours} ساعت)\n`+
      `کیف پول: ${meta.wallet} واحد`,
      mainKeyboard()
    );
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    const prefs = getUserPrefs(userId);
    const text = ctx.message?.text || '';

    // Seed/GUIDANCE حذف شده است

    // نادیده‌گرفتن متن‌های مربوط به کیبورد
    const controlLabels = new Set([
      '🖼 تولید عکس', '⚙️ تنظیمات', '👤 حساب کاربری', '💳 خرید اشتراک',
      'کیفیت: 1080p', 'کیفیت: 720p'
    ]);
    if (controlLabels.has(text)) {
      return; // توسط bot.hears هندل می‌شود
    }

    // Generate image from any text
    const { prompt, negative } = parseUserText(text);
    const typing = ctx.replyWithChatAction('upload_photo').catch(() => {});
    if (!quotaCheck(ctx)) return;
    const status = await ctx.reply('در حال ساخت تصویر… ⏳');
    try {
      const dims = dimsFromSize(prefs.size);
      const result = await generateImage(cfg, {
        prompt: `${prompt}`.trim(),
        negative_prompt: negative,
        width: dims.width,
        height: dims.height,
        response_format: prefs.response_format,
      });
      const caption = `✅ آماده شد | مدل: nano-banana`;
      // ترجیح ارسال باینری
      if (result.base64) {
        const buf = Buffer.from(result.base64, 'base64');
        await ctx.replyWithPhoto({ source: buf }, { caption });
      } else if (result.url) {
        await ctx.replyWithPhoto(result.url, { caption });
      } else {
        await ctx.reply('پاسخی از سرویس تصویر دریافت نشد. لطفاً دوباره تلاش کنید.');
      }
      const u = getUsage(userId); u.used += 1;
      storeLastJob(userId, { prompt, negative, prefs: { ...prefs }, result });
    } catch (err) {
      const reason = err && err.message ? String(err.message) : 'نامشخص';
      await ctx.reply(`⚠️ خطا در تولید تصویر: ${reason}`);
    } finally {
      try { await ctx.deleteMessage(status.message_id); } catch (_) {}
      await typing;
    }
  });

  // Post-image actions: از طریق دستورات /var و /up استفاده کنید

  bot.launch().then(() => {
    console.log('Bot launched');
  }).catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main();