const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

function getProxyAgent() {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const socksProxy = process.env.SOCKS_PROXY;

  if (socksProxy) {
    console.log('[img-api] Using SOCKS proxy:', socksProxy);
    return new SocksProxyAgent(socksProxy);
  }
  if (httpsProxy) {
    console.log('[img-api] Using HTTPS proxy:', httpsProxy);
    return new HttpsProxyAgent(httpsProxy);
  }
  return null;
}

const proxyAgent = getProxyAgent();

function sanitizeBase(base) {
  if (!base) return '';
  return String(base).trim().replace(/`/g, '');
}

function createClient(cfg, token) {
  const base = sanitizeBase(cfg.image_api?.api_base);
  
  if (!base) {
    throw new Error('Image API base URL is missing in config');
  }

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

  if (proxyAgent) {
    axiosCfg.httpAgent = proxyAgent;
    axiosCfg.httpsAgent = proxyAgent;
    axiosCfg.proxy = false;
  }
  
  return axios.create(axiosCfg);
}

function extractImages(data) {
  if (!data) return [];

  if (Array.isArray(data.images)) return data.images;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.output)) {
    return data.output.map((x) => ({ url: typeof x === 'string' ? x : x?.url, base64: x?.base64 || x?.b64_json }));
  }

  if (data.result && (Array.isArray(data.result.images) || data.result.image)) {
    return Array.isArray(data.result.images) ? data.result.images : [data.result.image];
  }

  const payload = data.data;
  if (payload) {
    if (Array.isArray(payload)) {
      return payload.map((x) => (typeof x === 'string' ? { url: x } : x));
    }
    if (Array.isArray(payload?.images)) return payload.images;
    if (payload?.image) return [payload.image];
  }

  if (data.image) return [data.image];
  if (data.url || data.base64 || data.image_url || data.image_base64 || data.b64_json) {
    return [{ 
      url: data.url || data.image_url || null, 
      base64: data.base64 || data.image_base64 || data.b64_json || null 
    }];
  }

  if (data?.data?.info?.resultImageUrl) {
    const u = data.data.info.resultImageUrl;
    return [{ url: typeof u === 'string' ? u.trim() : (u?.url || null) }];
  }
  
  return [];
}

async function generateImage(cfg, { prompt, negative_prompt, width, height, steps, guidance, seed, style, n, response_format } = {}) {
  let token = process.env.IMAGE_API_TOKEN;
  if (typeof token === 'string') {
    token = token.trim();
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
  
  const isNanoBanana = String(cfg.image_api?.provider || '').toLowerCase().includes('nano-banana');
  
  const body = isNanoBanana ? {
    prompt,
    type: defaults.type || 'TEXTTOIMAGE',
    numImages: n ?? defaults.n ?? 1,
  } : {

    prompt,
    negative_prompt: negative_prompt || undefined,
    width: width ?? defaults.width ?? 1024,
    height: height ?? defaults.height ?? 1024,
    n: n ?? defaults.n ?? 1,
    response_format: rf,

    type: defaults.type || 'text-to-image',
    size: `${width ?? defaults.width ?? 1024}x${height ?? defaults.height ?? 1024}`,
    format: rf, 
    count: n ?? defaults.n ?? 1,
    steps: steps ?? defaults.steps ?? 28,
    guidance: guidance ?? defaults.guidance ?? 7.5,
    seed: seed ?? undefined,
    style: style ?? undefined,
  };

  if (!body.prompt || String(body.prompt).trim().length === 0) {
    throw new Error('Prompt is required');
  }

  const retries = cfg.image_api?.retry_policy?.retries ?? 2;
  const backoff = cfg.image_api?.retry_policy?.backoff_ms ?? 1500;
  let lastErr;

  for (const ep of endpoints) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`[img-api] Request ${method} ${ep} (Attempt ${attempt + 1}/${retries + 1})`);
        
        const resp = await client.request({
          url: ep,
          method,
          data: body,
        });
        
        const data = resp.data || {};
        const images = extractImages(data);
        const code = (data.code != null) ? Number(data.code) : (data.status != null ? Number(data.status) : undefined);
        const msg = data.msg || data.message || data.error || 'no message';

        if (images.length > 0) {
          const img = images[0] || {};
          const cleanUrl = typeof img.url === 'string'
            ? img.url.trim()
            : (img.url?.url || img.url?.href || null);
            
          return {
            url: cleanUrl,
            base64: img.base64 || null,
            meta: img.meta || {},
          };
        }

        if (isNanoBanana && data?.data?.taskId) {
          const taskId = data.data.taskId;
          console.log(`[img-api] NanoBanana taskId دریافت شد: ${taskId} — شروع پولینگ وضعیت...`);
          
          const statusPath = '/record-info';
          const maxWaitMs = cfg.image_api?.timeouts?.read_ms || 120000;
          const pollIntervalMs = Math.min(5000, Math.max(1000, (cfg.image_api?.retry_policy?.backoff_ms || 1500)));
          const started = Date.now();
          
          while (Date.now() - started < maxWaitMs) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            try {
              const statusResp = await client.request({
                url: `${statusPath}?taskId=${encodeURIComponent(taskId)}`,
                method: 'GET',
              });
              
              const sData = statusResp.data || {};
              const sCode = (sData.code != null) ? Number(sData.code) : (sData.status != null ? Number(sData.status) : undefined);
              const sMsg = sData.msg || sData.message || sData.error || 'unknown message';

              if (sCode === 200 && sData?.data?.info?.resultImageUrl) {
                const url = sData.data.info.resultImageUrl;
                console.log('[img-api] NanoBanana تصویر آماده شد:', url);

                try {
                  const fileResp = await client.request({ 
                    url, 
                    method: 'GET', 
                    responseType: 'arraybuffer',
                    httpAgent: proxyAgent,
                    httpsAgent: proxyAgent,
                    proxy: false,
                  });
                  const buf = Buffer.from(fileResp.data);
                  const b64 = buf.toString('base64');
                  return { url, base64: b64, meta: { taskId } };
                } catch (dlErr) {
                  const dStatus = dlErr?.response?.status;
                  const dMsg = (dlErr?.response?.data && (dlErr.response.data.error || dlErr.response.data.message || dlErr.response.data.msg)) || dlErr.message || 'Unknown error';
                  console.warn(`[img-api] دانلود تصویر NanoBanana ناموفق ${dStatus || ''}: ${dMsg} — بازگردانی URL خام`);
                  return { url, base64: null, meta: { taskId } }; 
                }
              }

              if (sCode === 400 || sCode === 500 || sCode === 501 || sCode === 3 || sCode === 2) {
                throw new Error(`NanoBanana task failed (code=${sCode}): ${sMsg}`);
              }

              if (sCode === 0 || sCode === 1) {
                continue; 
              }
              
              console.log(`[img-api] NanoBanana task status ${sCode}: ${sMsg} - continuing to poll.`);

            } catch (pollErr) {
              const pStatus = pollErr?.response?.status;
              const pMsg = (pollErr?.response?.data && (pollErr.response.data.error || pollErr.response.data.message || pollErr.response.data.msg)) || pollErr.message || 'Unknown error';
              
              if (pStatus === 404 || pStatus === 400) {
                console.warn(`[img-api] NanoBanana polling API error ${pStatus}: ${pMsg} - Aborting polling for this task.`);
                throw new Error(`NanoBanana polling failed: ${pMsg}`);
              }
              // خطاهای موقت دیگر (مثل 5xx)
              console.warn(`[img-api] NanoBanana polling temporary error ${pStatus || ''}: ${pMsg}`);
            }
          }
          throw new Error('NanoBanana polling timed out without result image');
        }

        const keys = Object.keys(data || {});
        throw new Error(`Image API returned no images (keys: ${keys.join(',') || '-'}, msg: ${msg})`);

      } catch (err) {
        lastErr = err;

        if (err.response && err.response.status === 404) {
          console.warn(`[img-api] 404 Not Found on ${ep}, trying next endpoint if available...`);
          break; 
        }

        const isRetryable = !err.response || err.response.status >= 500 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        
        if (isRetryable && attempt < retries) {
          console.warn(`[img-api] Temporary error or Timeout (Status: ${err.response?.status || err.code || 'Unknown'}) - Retrying in ${backoff * (attempt + 1)}ms...`);
          await new Promise((res) => setTimeout(res, backoff * (attempt + 1)));
          continue;
        }

        if (err.response) {
          const status = err.response.status;
          const d = err.response.data;
          const msg = (d && (d.error || d.message || d.msg)) || err.message || 'Unknown error';
          throw new Error(`Image API error ${status}: ${msg}`);
        }
        throw err;
      }
    }
  }

  throw lastErr || new Error('Image generation failed after all endpoint retries');
}

module.exports = { generateImage };
