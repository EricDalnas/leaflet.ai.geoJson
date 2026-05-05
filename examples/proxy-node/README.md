# proxy-node

A minimal local Express proxy for leaflet.ai.geojson. Your Gemini API key stays in a `.env` file on your machine — the browser never sees it.

> ⚠ **Local development only.**
>
> This server binds to `127.0.0.1` by default and has no authentication. Do not expose it to the internet without adding proper auth (session cookies, a shared secret, OAuth, etc.) and a spend cap on the key. See the security comments in `server.js` for details.

## How it works

1. The browser POSTs a query to `http://localhost:3000/llm`
2. The proxy signs the request with your API key and forwards it to Gemini
3. The response comes back to the browser as plain text — no key ever leaves the server

## Setup

**1. Install dependencies** (one-time, from this folder):

```bash
cd examples/proxy-node
npm install
```

**2. Create a `.env` file in this folder** (copy from `.env.example`):

```
GEMINI_API_KEY=AIza...
```

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — 1,500 req/day, no credit card.

Optional env vars:

```
PORT=3000            # default 3000
BIND_HOST=127.0.0.1  # default — loopback only
RATE_LIMIT_RPM=20    # requests per minute per IP
```

**3. Start the server:**

```bash
npm start             # from examples/proxy-node/
# or from the repo root:
npm run proxy
```

**4. Open the demo:**

```
http://localhost:3000/examples/proxy-node/index.html
```

## Using with your own page

```js
L.control.aiGeojson({
  proxyUrl:     '/llm',
  modelListUrl: '/models',
  model:        'gemini-2.5-flash'
}).addTo(map);
```

## Swapping to OpenRouter

Replace the Gemini fetch block in `server.js` with an OpenAI-compatible call:

```js
const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY
  },
  body: JSON.stringify({
    model, temperature, max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: message }
    ]
  })
});
const data = await upstream.json();
res.json({ text: data.choices[0].message.content });
```

## Going to production

This proxy is a starting point, not a production-ready server. For a real deployment you need:

- Authentication (session cookies, a shared secret header, or OAuth)
- A reverse proxy (nginx/Caddy) in front with TLS
- `BIND_HOST=127.0.0.1` so only the reverse proxy can reach the Node process
- A spend cap on your API key

For a fully deployable solution, see [`../proxy-azure`](../proxy-azure).
