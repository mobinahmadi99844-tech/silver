const axios = require('axios');
let proxyAgent = null;
try {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const { SocksProxyAgent } = require('socks-proxy-agent');
  const httpsProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const socksProxy = process.env.SOCKS_PROXY;
  if (socksProxy) {
    proxyAgent = new SocksProxyAgent(socksProxy);
    console.log('[img-api] Using SOCKS proxy:', socksProxy);
  } else if (httpsProxy) {
    proxyAgent = new HttpsProxyAgent(httpsProxy);
    console.log('[img-api] Using HTTPS proxy:', httpsProxy);
  }
} catch (e) {
  // optional deps may be missing; skip silently
}

function sanitizeBase(base) {
  if (!base) return '';
  return String(base).trim().replace(/`/g, '');
}

function createClient(cfg, token) {
  const base = sanitizeBase(cfg.image_api?.api_base);
  const headers = {
    ...(cfg.image_api?.headers || {}),
    Authorization: token ? `Bearer ${token}` : undefined,
    'X-API-KEY': token || undefined,
  };

  const axiosCfg = {
    baseURL: base,
    headers,
    timeout: cfg.image_api?.timeouts?.read_ms || 120000,
    validateStatus: (s) => s >= 200 && s < 300,
  };
  // استفاده از پروکسی اگر موجود باشد
  if (proxyAgent) {
    axiosCfg.httpAgent = proxyAgent;
    axiosCfg.httpsAgent = proxyAgent;
    axiosCfg.proxy = false; // جلوگیری از رفتار پیش‌فرض axios
  }
  return axios.create(axiosCfg);
}

async function generateImage(cfg, { prompt, negative_prompt, width, height, steps, guidance, seed, style, n, response_format } = {}) {
  let token = process.env.IMAGE_API_TOKEN;
  // پاک‌سازی احتمالی آلودگی‌ها یا فاصله‌ها در توکن
  if (typeof token === 'string') {
    token = token.trim();
    const m = token.match(/^[A-Za-z0-9_-]+/);
    token = m ? m[0] : token;
  }
  if (!token) {
    throw new Error('IMAGE_API_TOKEN missing in environment');
  }

  const client = createClient(cfg, token);
  const method = (cfg.image_api?.method || 'POST').toUpperCase();
  const endpoints = [
    cfg.image_api?.endpoint || '/generate',
    ...((cfg.image_api?.alt_endpoints && Array.isArray(cfg.image_api.alt_endpoints)) ? cfg.image_api.alt_endpoints : ['/generate', '/image/generate', '/images', '/images/generate'])
  ].filter(Boolean);

  const defaults = cfg.image_api?.request_schema || {};
  const rf = response_format != null ? response_format : (defaults.response_format != null ? defaults.response_format : 'url');
  // اگر provider نانو‌بانانا باشد، بدنه درخواست را طبق مستند رسمی ساده‌سازی می‌کنیم
  const isNanoBanana = String(cfg.image_api?.provider || '').toLowerCase().includes('nano-banana');
  const body = isNanoBanana ? {
    prompt,
    type: defaults.type || 'TEXTTOIAMGE',
    numImages: n ?? defaults.n ?? 1,
    // callBackUrl, watermark, imageUrls اختیاری هستند؛ فعلاً استفاده نمی‌کنیم
  } : {
    model: defaults.model || undefined,
    prompt,
    // برخی APIها به‌جای prompt از text استفاده می‌کنند
    text: prompt,
    negative_prompt: negative_prompt || undefined,
    width: width ?? defaults.width ?? 1024,
    height: height ?? defaults.height ?? 1024,
    steps: steps ?? defaults.steps ?? 28,
    guidance: guidance ?? defaults.guidance ?? 7.5,
    seed: seed ?? undefined,
    style: style ?? undefined,
    n: n ?? defaults.n ?? 1,
    response_format: rf,
    // برخی APIها نیازمند type هستند؛ مقدار پیش‌فرض را بعداً با fallback تنظیم می‌کنیم
    type: defaults.type || 'text-to-image',
    // برخی APIها به‌جای width/height، size رشته‌ای می‌خواهند
    size: `${width ?? defaults.width ?? 1024}x${height ?? defaults.height ?? 1024}`,
    // برخی APIها به‌جای response_format از format استفاده می‌کنند
    format: rf,
    // برخی APIها شمارنده را با نام دیگری می‌پذیرند
    count: n ?? defaults.n ?? 1,
  };

  if (!body.prompt || String(body.prompt).trim().length === 0) {
    throw new Error('Prompt is required');
  }

  const retries = cfg.image_api?.retry_policy?.retries ?? 2;
  const backoff = cfg.image_api?.retry_policy?.backoff_ms ?? 1500;

  function extractImages(data) {
    if (!data) return [];
    // الگوهای رایج
    if (Array.isArray(data.images)) return data.images;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.output)) return data.output.map((x) => ({ url: typeof x === 'string' ? x : x?.url, base64: x?.base64 || x?.b64_json }));
    if (data.result && (Array.isArray(data.result.images) || data.result.image)) {
      const imgs = Array.isArray(data.result.images) ? data.result.images : [data.result.image];
      return imgs;
    }
    if (data.image) return [data.image];
    // داده‌های تو در تو در data
    const payload = data.data;
    if (payload) {
      if (Array.isArray(payload)) {
        return payload.map((x) => (typeof x === 'string' ? { url: x } : x));
      }
      if (Array.isArray(payload?.images)) return payload.images;
      if (payload?.image) return [payload.image];
      if (payload?.url || payload?.base64 || payload?.image_url || payload?.image_base64 || payload?.b64_json) {
        return [{ url: payload.url || payload.image_url || null, base64: payload.base64 || payload.image_base64 || payload.b64_json || null }];
      }
    }
    // تک‌مقدارهای مستقیم
    if (data.url || data.base64 || data.image_url || data.image_base64 || data.b64_json) {
      return [{ url: data.url || data.image_url || null, base64: data.base64 || data.image_base64 || data.b64_json || null }];
    }
    // مسیر اختصاصی نانو‌بانانا: آدرس تصویر در data.info.resultImageUrl
    if (data?.data?.info?.resultImageUrl) {
      return [{ url: data.data.info.resultImageUrl }];
    }
    // هیچ چیزی پیدا نشد
    return [];
  }

  let lastErr;
  for (const ep of endpoints) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`[img-api] Request ${method} ${ep}`);
        const resp = await client.request({
          url: ep,
          method,
          data: body,
        });
        const data = resp.data || {};
        const images = extractImages(data);
        const code = (data.code != null) ? Number(data.code) : (data.status != null ? Number(data.status) : undefined);
        const ok = data.ok === true || data.success === true || (code === 200 || code === 0) || images.length > 0;
        // اگر مستقیماً تصویر دریافت شد
        if (ok && images.length > 0) {
          const img = images[0] || {};
          return {
            url: img.url || null,
            base64: img.base64 || null,
            meta: img.meta || {},
          };
        }
        const keys = Object.keys(data || {});
        const msg = data.msg || data.message || data.error || 'no message';
        console.warn('[img-api] No images in response:', JSON.stringify({ keys, msg }).slice(0, 500));

        // جریان دو مرحله‌ای نانو‌بانانا: دریافت taskId و سپس پولینگ /record-info
        if (isNanoBanana && ((code === 200 || code === 0) && data?.data?.taskId)) {
          const taskId = data.data.taskId;
          console.log(`[img-api] NanoBanana taskId دریافت شد: ${taskId} — شروع پولینگ وضعیت...`);
          const statusPath = '/record-info';
          const maxWaitMs = cfg.image_api?.timeouts?.read_ms || 120000;
          const pollIntervalMs = Math.min(5000, Math.max(1000, (cfg.image_api?.retry_policy?.backoff_ms || 1500)));
          const started = Date.now();
          while (Date.now() - started < maxWaitMs) {
            try {
              const statusResp = await client.request({
                url: `${statusPath}?taskId=${encodeURIComponent(taskId)}`,
                method: 'GET',
              });
              const sData = statusResp.data || {};
              const sCode = (sData.code != null) ? Number(sData.code) : (sData.status != null ? Number(sData.status) : undefined);
              if (sCode === 200 && sData?.data?.info?.resultImageUrl) {
                const url = sData.data.info.resultImageUrl;
                console.log('[img-api] NanoBanana تصویر آماده شد:', url);
                // تلاش برای دانلود تصویر و بازگرداندن base64 برای ارسال مستقیم
                try {
                  const fileResp = await client.request({ url, method: 'GET', responseType: 'arraybuffer' });
                  const buf = Buffer.from(fileResp.data);
                  const b64 = buf.toString('base64');
                  return { url, base64: b64, meta: { taskId } };
                } catch (dlErr) {
                  const dStatus = dlErr?.response?.status;
                  const dMsg = (dlErr?.response?.data && (dlErr.response.data.error || dlErr.response.data.message || dlErr.response.data.msg)) || dlErr.message || 'Unknown error';
                  console.warn(`[img-api] دانلود تصویر NanoBanana ناموفق ${dStatus || ''}: ${dMsg} — بازگردانی URL`);
                  return { url, base64: null, meta: { taskId } };
                }
              }
              if (sCode === 400 || sCode === 500 || sCode === 501 || sCode === 3 || sCode === 2) {
                throw new Error(`NanoBanana task failed (code=${sCode}): ${sData.msg || 'unknown'}`);
              }
              // وضعیت 0: در حال تولید — صبر کن و دوباره امتحان کن
              await new Promise((r) => setTimeout(r, pollIntervalMs));
              continue;
            } catch (pollErr) {
              const pStatus = pollErr?.response?.status;
              const pMsg = (pollErr?.response?.data && (pollErr.response.data.error || pollErr.response.data.message || pollErr.response.data.msg)) || pollErr.message || 'Unknown error';
              console.warn(`[img-api] NanoBanana polling error ${pStatus || ''}: ${pMsg}`);
              if (pStatus === 404) break; // در صورت مسیر نادرست، از این اندپوینت خارج شو
              await new Promise((r) => setTimeout(r, pollIntervalMs));
            }
          }
          throw new Error('NanoBanana polling timed out without result image');
        }

        // اگر پیام خطا درباره type باشد، به‌صورت خودکار انواع جایگزین را امتحان کن (برای APIهای غیر نانو‌بانانا)
        const typeCandidates = [
          ...(defaults.type ? [defaults.type] : []),
          'txt2img', 'text', 'prompt', 'text-to-image', 'text2image', 'generate', 'image'
        ];
        const tried = new Set([body.type]);
        if (!isNanoBanana && (/incorrect\s*type/i.test(String(msg)) || /type\s*can\s*not\s*be\s*blank/i.test(String(msg)))) {
          const altFormats = [body.response_format, 'base64', 'url'].filter(Boolean);
          const shapes = [
            (b, t) => ({ ...b, type: t }),
            (b, t) => ({ ...b, request_type: t }),
            (b, t) => ({ ...b, task_type: t }),
            (b, t) => ({ ...b, mode: t }),
            (b, t) => ({ ...b, params: { ...b, type: t } }),
            (b, t) => ({ ...b, data: { type: t, prompt: b.prompt || b.text, width: b.width, height: b.height, size: b.size, format: b.format || b.response_format, n: b.n || b.count } })
          ];
          for (const altType of typeCandidates.concat([0, 1])) {
            if (tried.has(String(altType))) continue;
            tried.add(String(altType));
            for (const altFmt of altFormats) {
              for (const sh of shapes) {
                const retryBody = sh({ ...body, response_format: altFmt, format: altFmt }, altType);
                console.warn(`[img-api] Retrying with type="${altType}" format="${altFmt}" shape=${shapes.indexOf(sh)} ...`);
                try {
                  const retryResp = await client.request({ url: ep, method, data: retryBody });
                  const retryData = retryResp.data || {};
                  const retryImages = extractImages(retryData);
                  const retryCode = (retryData.code != null) ? Number(retryData.code) : (retryData.status != null ? Number(retryData.status) : undefined);
                  const retryOk = retryData.ok === true || retryData.success === true || (retryCode === 200 || retryCode === 0) || retryImages.length > 0;
                  if (retryOk && retryImages.length > 0) {
                    const img = retryImages[0] || {};
                    return { url: img.url || null, base64: img.base64 || null, meta: img.meta || {} };
                  }
                  const rKeys = Object.keys(retryData || {});
                  const rMsg = retryData.msg || retryData.message || retryData.error || 'no message';
                  console.warn('[img-api] Retry still no images:', JSON.stringify({ keys: rKeys, msg: rMsg }).slice(0, 500));
                } catch (retryErr) {
                  const status = retryErr?.response?.status;
                  const rData = retryErr?.response?.data;
                  const rMsg = (rData && (rData.error || rData.message || rData.msg)) || retryErr.message || 'Unknown error';
                  console.warn(`[img-api] Retry error (type=${altType}) ${status || ''}: ${rMsg}`);
                  if (status === 404) break; // اگر مسیر غلط بود، اندپوینت بعدی
                }
              }
            }
          }
        }

        throw new Error(`Image API returned no images (keys: ${keys.join(',') || '-'}, msg: ${msg})`);
      } catch (err) {
        lastErr = err;
        // اگر 404 بود، سراغ اندپوینت بعدی برو
        if (err.response && err.response.status === 404) {
          console.warn(`[img-api] 404 Not Found on ${ep}, trying next endpoint if available...`);
          break; // خروج از حلقه تلاش و رفتن به اندپوینت بعدی
        }
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, backoff * (attempt + 1)));
          continue;
        }
        // افزودن جزئیات خطا برای دیباگ بهتر
        if (err.response) {
          const status = err.response.status;
          const d = err.response.data;
          const msg = (d && (d.error || d.message)) || err.message || 'Unknown error';
          throw new Error(`Image API error ${status}: ${msg}`);
        }
        throw err;
      }
    }
  }

  throw lastErr || new Error('Image generation failed');
}

module.exports = { generateImage };