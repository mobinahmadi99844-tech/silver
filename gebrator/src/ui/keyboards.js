const { Markup } = require('telegraf');

function mainKeyboard() {
  return Markup.keyboard([
    ['🖼 تولید عکس'],
    ['⚙️ تنظیمات', '👤 حساب کاربری'],
    ['💳 خرید اشتراک'],
  ]).resize();
}

function settingsKeyboard() {
  return Markup.keyboard([
    ['کیفیت: 1080p', 'کیفیت: 720p'],
  ]).resize();
}

module.exports = { mainKeyboard, settingsKeyboard };