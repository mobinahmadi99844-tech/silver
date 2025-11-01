const fs = require('fs');
const path = require('path');
require('dotenv').config();

function loadJson(filePath) {
  const fullPath = path.resolve(filePath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  return JSON.parse(raw);
}

function getConfig() {
  const token = process.env.BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error('BOT_TOKEN is missing in .env');
  }

  const appConfig = loadJson(path.join(__dirname, '..', 'config', 'app.config.json'));
  return {
    token,
    ...appConfig
  };
}

module.exports = { getConfig };