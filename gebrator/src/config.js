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

  {
  "image_api": {
    "provider": "nano-banana",
    "api_base": "https://api.nanobananaapi.ai/api/v1/nanobanana",
    "endpoint": "/generate",
    "timeouts": { "read_ms": 300000 },
    "retry_policy": { "retries": 5, "backoff_ms": 2000 }
  }
}
  return {
    token,
    ...appConfig
  };
}

module.exports = { getConfig };
