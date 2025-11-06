const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
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
}

const { getConfig } = require('./config');
const { generateImage } = require('./services/imageGenerator');
const { createRateLimit } = require('./middlewares/rateLimit');
const { createSafety } = require('./middlewares/safety');
const { mainKeyboard, settingsKeyboard } = require('./ui/keyboards');

function main() {
  const cfg = getConfig();
  const bot = proxyAgent ? new Telegraf(cfg.token, { telegram: { agent: proxyAgent } }) : new Telegraf(cfg.token);

  const userPrefs = new Map();
  const usage = new Map();
  const userMeta = new Map();
  const lastJobs = new Map();


  function getUsage(userId) {
    const u = usage.get(userId) || { plan: 'free', used: 0, limit: 20 };
    usage.set(userId, u);
    return u;
  }

  function getUserPrefs(userId) {
    const p = userPrefs.get(userId) || { response_format: 'url', size: 1080 };
    userPrefs.set(userId, p);
    return p;
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

  async function sendImageResult(ctx, result) {
    const caption = `✅ تصویر آماده شد | مدل: nano-banana`;

    if (result?.base64) {
      const buf = Buffer.from(result.base64, 'base64');
      await ctx.replyWithPhoto({ source: buf, filename: 'image.png' }, { caption });
      return true;
    }

    if (result?.url) {
      const rawUrl = String(result.url).trim().replace(/^"+|"+$/g, '');
      if (!/^https?:\/\/.+/i.test(rawUrl)) {
        throw new Error(`Bad image URL: "${rawUrl}"`);
      }

      try {
        await ctx.replyWithPhoto(rawUrl, { caption });
        return true;
      } catch (e) {
        console.warn('[img-bot] send by URL failed, will download & upload. err=', e?.message || e);
        try {
          const resp = await axios.get(rawUrl, { responseType: 'arraybuffer' });
          const buf = Buffer.from(resp.data);
          await ctx.replyWithPhoto({ source: buf, filename: 'image.png' }, { caption });
          return true;
        } catch (dlErr) {
          console.error('[img-bot] download failed:', dlErr?.message || dlErr);
          throw new Error('Failed to fetch image from URL');
        }
      }
    }

    return false; 
  }

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

  bot.hears('🖼 تولید عکس', async (ctx) => {
    await ctx.reply('لطفاً متنِ تصویر موردنظر (پرامپت) را ارسال کنید.');
  });

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

  bot.hears('💳 خرید اشتراک', async (ctx) => {
    const u = getUsage(ctx.from?.id);
    u.plan = 'pro';
    u.limit = Infinity;
    await ctx.reply('تبریک! اشتراک شما به پلن Pro ارتقا یافت و محدودیت برداشته شد.', mainKeyboard());
  });

  bot.hears('👤 حساب کاربری', async (ctx) => {
    const userId = ctx.from?.id;
    const u = getUsage(userId);
    const meta = userMeta.get(userId) || { joinedAt: new Date(), wallet: 0 };
    userMeta.set(userId, meta);
    
    const now = Date.now();
    const joinedTime = new Date(meta.joinedAt).getTime();
    const diffMs = now - joinedTime;
    const diffDays = Math.floor(diffMs / (24*60*60*1000));
    const diffHours = Math.floor((diffMs % (24*60*60*1000)) / (60*60*1000));
    
    const joinedStr = new Date(meta.joinedAt).toISOString().split('T')[0];
    
    await ctx.reply(
      `آمار حساب کاربری:\n`+
      `آیدی عددی: ${userId}\n`+
      `مصرف: ${u.used}${u.limit === Infinity ? '/∞' : '/' + u.limit} | پلن: ${u.plan}\n`+
      `تاریخ عضویت: ${joinedStr} (مدت: ${diffDays} روز و ${diffHours} ساعت)\n`+
      `کیف پول: ${meta.wallet} واحد`,
      mainKeyboard()
    );
  });

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
        n: 1 
      });

      const sent = await sendImageResult(ctx, result);
      
      if (!sent) {
        throw new Error('پاسخی از سرویس تصویر دریافت نشد.');
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

  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    const prefs = getUserPrefs(userId);
    const text = ctx.message?.text || '';

    const controlLabels = new Set([
      '🖼 تولید عکس', '⚙️ تنظیمات', '👤 حساب کاربری', '💳 خرید اشتراک',
      'کیفیت: 1080p', 'کیفیت: 720p'
    ]);
    if (controlLabels.has(text)) {
      return;
    }

    const { prompt, negative } = parseUserText(text);
    if (prompt.length < 3) {
      return ctx.reply('لطفاً یک پرامپت (متن) کامل‌تر برای تولید تصویر ارسال کنید.');
    }
    
    if (!quotaCheck(ctx)) return;
    
    const status = await ctx.reply('در حال ساخت تصویر… ⏳');
    const typing = ctx.replyWithChatAction('upload_photo').catch(() => {});

    try {
      const dims = dimsFromSize(prefs.size);
      const result = await generateImage(cfg, {
        prompt: `${prompt}`.trim(),
        negative_prompt: negative,
        width: dims.width,
        height: dims.height,
        response_format: prefs.response_format,
      });
      
      const sent = await sendImageResult(ctx, result);
      
      if (!sent) {
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

  bot.launch().then(() => {
    console.log('Bot launched');
  }).catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main();
