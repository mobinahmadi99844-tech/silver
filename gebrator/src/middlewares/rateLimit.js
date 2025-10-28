// Simple cooldown middleware: enforce 5 seconds between user actions

function createRateLimit(cfg) {
  const cooldownMs = cfg.security?.cooldown_ms ?? 5000; // default 5s

  const lastSeen = new Map(); // userId -> last timestamp

  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();
    const last = lastSeen.get(userId) || 0;
    const diff = now - last;

    if (diff < cooldownMs) {
      const remain = Math.ceil((cooldownMs - diff) / 1000);
      await ctx.reply(`لطفاً ${remain} ثانیه صبر کن سپس دوباره ارسال کن.`);
      return;
    }

    lastSeen.set(userId, now);
    return next();
  };
}

module.exports = { createRateLimit };