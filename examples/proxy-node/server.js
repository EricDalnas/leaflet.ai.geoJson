/**
 * Minimal Node.js/Express proxy server for leaflet.ai.geojson.
 *
 * ── SECURITY WARNING ───────────────────────────────────────────────────────
 *
 *   THIS SERVER IS FOR LOCAL DEVELOPMENT ONLY.
 *
 *   By default it binds to 127.0.0.1 (loopback) so it is unreachable from
 *   any other machine on the network. It also rate-limits requests per IP.
 *
 *   DO NOT expose this server to the public internet without adding proper
 *   authentication (e.g. session cookies, a shared secret header, or an
 *   OAuth-gated reverse proxy). Anyone who can reach the /llm endpoint can
 *   consume your API quota and run up a bill.
 *
 *   If you deploy this to a server:
 *     • Put it behind a reverse proxy (nginx/Caddy) with auth
 *     • Set BIND_HOST=127.0.0.1 so only the reverse proxy can reach it
 *     • Set strict rate limits (RATE_LIMIT_RPM env var)
 *     • Set a spend cap on your Gemini key
 *
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The browser plugin POSTs:
 *   { message, systemPrompt, model, temperature, maxTokens }
 *
 * This server forwards the request to Gemini using an API key stored in an
 * environment variable — no key ever reaches the browser.
 *
 * ── Quick start ────────────────────────────────────────────────────────────
 *
 *   1. Install dependencies (one-time, from examples/proxy-node/):
 *        cd examples/proxy-node
 *        npm install
 *
 *   2. Create a .env file in examples/proxy-node/ (copy from .env.example):
 *        GEMINI_API_KEY=AIza...
 *        PORT=3000          # optional, defaults to 3000
 *        BIND_HOST=127.0.0.1  # default — loopback only; change only behind a proper auth proxy
 *        RATE_LIMIT_RPM=20    # optional, requests per minute per IP (default 20)
 *
 *   3. Run the server:
 *        npm run proxy          (from the repo root)
 *      or
 *        npm start              (from examples/proxy-node/)
 *
 *   4. Open http://localhost:3000/examples/proxy-node/index.html
 *
 * ── Using in your Leaflet page ─────────────────────────────────────────────
 *
 *   L.control.aiGeojson({
 *     proxyUrl: '/llm',
 *     model:    'gemini-2.5-flash'
 *   }).addTo(map);
 *
 * ── Swapping to OpenRouter ─────────────────────────────────────────────────
 *
 *   Replace the Gemini fetch block with an OpenAI-compatible call:
 *     const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json',
 *                  'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY },
 *       body: JSON.stringify({
 *         model, temperature, max_tokens: maxTokens,
 *         messages: [{ role: 'system', content: systemPrompt },
 *                    { role: 'user',   content: message }]
 *       })
 *     });
 *     const data = await upstream.json();
 *     res.json({ text: data.choices[0].message.content });
 */

'use strict';

// Load .env file if present (install dotenv: npm install --save-dev dotenv)
try { require('dotenv').config(); } catch (_) { /* dotenv not installed — use real env vars */ }

const path = require('path');
const express = require('express');

// Rate limiter — throttles /llm and /models per IP to prevent abuse.
// Default: 20 requests/minute. Override with RATE_LIMIT_RPM env var.
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (_) {
  console.warn('express-rate-limit not installed; rate limiting disabled. Run: npm install --save-dev express-rate-limit');
  rateLimit = null;
}

const app = express();

// Limit request body size to prevent oversized payloads.
app.use(express.json({ limit: '32kb' }));

// Serve the project root so /src/, /dist/, and /examples/ are all reachable.
app.use(express.static(path.join(__dirname, '../..')));

// Guard against DNS rebinding attacks: only accept requests whose Host header
// matches localhost / 127.0.0.1. A malicious page that DNS-rebinds to 127.0.0.1
// will still send its own domain name as Host, so this blocks it cold.
function rejectDnsRebinding(req, res, next) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return next();
  res.status(400).json({ error: 'Bad Host header — request rejected.' });
}
app.use('/llm', rejectDnsRebinding);
app.use('/models', rejectDnsRebinding);

// Apply rate limiting to API endpoints (not static files).
const RPM = parseInt(process.env.RATE_LIMIT_RPM, 10) || 20;
if (rateLimit) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: RPM,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — rate limit exceeded. Try again shortly.' }
  });
  app.use('/llm', limiter);
  app.use('/models', limiter);
  console.log('Rate limiting enabled: ' + RPM + ' requests/minute per IP.');
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY env var is not set. Requests will fail.');
}

// Keeps only text-generation models: gemini-* and gemma-* families,
// excluding TTS, image-generation, robotics, and computer-use variants.
function isTextModel(id) {
  if (!/^gemini-|^gemma-/i.test(id)) return false;
  if (/tts|robotics|computer.use|-image/i.test(id)) return false;
  return true;
}

// Allowed model IDs — populated at startup from the Gemini API so the list
// is always accurate. Falls back to an empty set (all requests rejected) if
// the key is not set or the fetch fails.
let ALLOWED_MODELS = new Set();

async function refreshAllowedModels() {
  if (!GEMINI_API_KEY) return;
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' +
      encodeURIComponent(GEMINI_API_KEY)
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    ALLOWED_MODELS = new Set(
      (data.models || [])
        .filter(m =>
          m.supportedGenerationMethods &&
          m.supportedGenerationMethods.includes('generateContent') &&
          (m.outputTokenLimit || 0) > 0 &&
          (m.inputTokenLimit  || 0) > 0 &&
          isTextModel(m.name.replace(/^models\//, ''))
        )
        .map(m => m.name.replace(/^models\//, ''))
    );
    console.log('Loaded ' + ALLOWED_MODELS.size + ' allowed models from Gemini API.');
  } catch (err) {
    console.warn('Could not fetch model list:', err.message);
  }
}

refreshAllowedModels();

// Known stable model IDs (mirrors L.Control.AiGeojson.STABLE_IDS).
const STABLE_IDS = [
  'gemini-2.5-pro', 'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'
];

function isPreviewModel(id) {
  if (STABLE_IDS.includes(id)) return false;
  return /preview|exp(erimental)?|latest|\d{4,}/i.test(id);
}

// GET /models — returns the filtered, sorted model list for the model picker.
// Re-uses the model set fetched at startup; re-fetches if it's empty (e.g. key was missing at boot).
app.get('/models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'No API key configured on server.' });
  if (ALLOWED_MODELS.size === 0) await refreshAllowedModels();
  if (ALLOWED_MODELS.size === 0) return res.status(500).json({ error: 'Could not load model list from Gemini API.' });
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' +
      encodeURIComponent(GEMINI_API_KEY)
    );
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const models = (data.models || []).filter(m =>
      m.supportedGenerationMethods &&
      m.supportedGenerationMethods.includes('generateContent') &&
      (m.outputTokenLimit || 0) > 0 &&
      (m.inputTokenLimit  || 0) > 0 &&
      isTextModel(m.name.replace(/^models\//, ''))
    );

    const items = models.map(m => ({
      id:               m.name.replace(/^models\//, ''),
      name:             m.displayName || m.name.replace(/^models\//, ''),
      inputTokenLimit:  m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit
    }));

    items.sort((a, b) => {
      const ai = STABLE_IDS.indexOf(a.id), bi = STABLE_IDS.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/llm', async (req, res) => {
  const { message, systemPrompt, model, temperature, maxTokens } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  const resolvedModel = model || 'gemini-2.5-flash';
  if (ALLOWED_MODELS.size > 0 && !ALLOWED_MODELS.has(resolvedModel)) {
    return res.status(400).json({ error: 'Model not allowed: ' + resolvedModel });
  }

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(resolvedModel) +
    ':generateContent?key=' +
    encodeURIComponent(GEMINI_API_KEY);

  const body = {
    contents: [{ role: 'user', parts: [{ text: message }] }],
    system_instruction: { parts: [{ text: systemPrompt || '' }] },
    generationConfig: {
      maxOutputTokens: typeof maxTokens === 'number' ? maxTokens : 8192,
      temperature:     typeof temperature === 'number' ? temperature : 0.2
    }
  };

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const msg = (data.error && data.error.message) || JSON.stringify(data);
      return res.status(upstream.status).json({ error: msg });
    }

    const text =
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0].text;

    if (!text) return res.status(500).json({ error: 'Unexpected Gemini response format.' });

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT      = parseInt(process.env.PORT, 10) || 3000;
// Default to loopback only — unreachable from other machines on the network.
// Change BIND_HOST only if this server sits behind an authenticated reverse proxy.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

app.listen(PORT, BIND_HOST, () => {
  if (BIND_HOST === '127.0.0.1' || BIND_HOST === 'localhost') {
    console.log('Proxy server running on http://localhost:' + PORT + ' (loopback only — not reachable from the network)');
  } else {
    console.warn('WARNING: Proxy server bound to ' + BIND_HOST + '. Ensure this is behind an authenticated reverse proxy.');
  }
  console.log('  -> http://localhost:' + PORT + '/examples/index.html        (proxy demo — start here)');
  console.log('  -> http://localhost:' + PORT + '/examples/browser-demo.html  (browser key demo)');
});
