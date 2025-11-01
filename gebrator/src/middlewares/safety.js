// Basic safety middleware: blocks messages containing blocklisted keywords

function createSafety(cfg) {
  const keywords = (cfg.security?.blocklist_keywords || []).map((k) => String(k).toLowerCase());
  const policy = cfg.security?.nsfw_policy || 'block_and_warn';

  function containsBlocked(text) {
    if (!text) return false;
    const t = String(text).toLowerCase();
    return keywords.some((kw) => kw && t.includes(kw));
  }

  return async (ctx, next) => {
    const text = ctx.message?.text || ctx.update?.inline_query?.query || '';

    if (containsBlocked(text)) {
      if (policy === 'block_and_warn') {
        await ctx.reply('متأسفانه پیام شما شامل محتوای نامجاز است و پردازش نمی‌شود.');
        return;
      }
    }

    return next();
  };
}

module.exports = { createSafety };