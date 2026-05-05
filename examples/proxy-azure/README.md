# proxy-azure

An ASP.NET Core proxy for leaflet.ai.geojson, deployable to Azure App Service. Your Gemini API key stays in Azure Application Settings — it never reaches the browser.

## What's included

- `LlmController.cs` — handles `POST /api/llm` (query forwarding)
- `ModelsController.cs` — handles `GET /api/models` (model list for the picker)
- `GeminiService.cs` — calls the Gemini API and normalises the response
- `RateLimiter.cs` — in-memory rate limiting per IP
- `RequestGuard.cs` — CORS enforcement and optional `X-Auth-Key` authentication
- `demo.html` — a simple Leaflet page that points at the deployed Azure URL

## Local setup

**Prerequisites:** .NET 10 SDK

**1. Create `local.settings.json`** in this folder (already gitignored):

```json
{
  "GEMINI_API_KEY": "AIza...",
  "ALLOWED_ORIGIN": "http://localhost:3000",
  "AUTH_KEY": "",
  "RATE_LIMIT_RPM": "20"
}
```

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**2. Run:**

```bash
dotnet run --project AzureProxy.csproj
```

The API listens on `https://localhost:7xxx` / `http://localhost:5xxx` (check terminal output for the exact port).

**3. Open `demo.html`** in a browser, or point your Leaflet page at `http://localhost:<port>`:

```js
L.control.aiGeojson({
  proxyUrl:     'http://localhost:<port>/api/llm',
  modelListUrl: 'http://localhost:<port>/api/models',
  model:        'gemini-2.5-flash'
}).addTo(map);
```

## Deploying to Azure App Service

**1. Create an App Service** (Free or B1 tier is fine for a demo).

**2. Set Application Settings** (in the Azure portal → Configuration → Application settings):

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini key |
| `ALLOWED_ORIGIN` | Your frontend URL (e.g. `https://you.github.io`) |
| `AUTH_KEY` | A random secret string (optional but recommended) |
| `RATE_LIMIT_RPM` | Requests per minute per IP (default 20) |

**3. Deploy** using the publish profile in `Properties/PublishProfiles/`, or via the Azure CLI:

```bash
dotnet publish -c Release
az webapp deploy --resource-group <rg> --name <app-name> --src-path bin/Release/net10.0/publish
```

**4. Update your Leaflet plugin config:**

```js
L.control.aiGeojson({
  proxyUrl:     'https://<your-app>.azurewebsites.net/api/llm',
  modelListUrl: 'https://<your-app>.azurewebsites.net/api/models',
  model:        'gemini-2.5-flash',
  modelPicker:  true,
  extraHeaders: { 'X-Auth-Key': '<your-AUTH_KEY>' }
}).addTo(map);
```

## Security model

- **CORS** — `ALLOWED_ORIGIN` restricts which browser origins can call the API. Set this to your frontend domain. Localhost is always allowed.
- **Auth key** — if `AUTH_KEY` is set, every request must include an `X-Auth-Key` header with the matching value. This prevents casual abuse from people who find the endpoint URL.
- **Rate limiting** — `RATE_LIMIT_RPM` caps requests per IP per minute in memory.
- **Body size** — requests over 32 KB are rejected.

Note: `AUTH_KEY` in a browser page is visible in source. It's a speed bump, not a lock. For stronger security, put the frontend behind Azure Static Web Apps with Azure AD authentication.

## Notes

- The proxy only supports Gemini today. To add OpenRouter or another provider, swap the `GeminiService` call in `LlmController.cs`.
- `local.settings.json` is gitignored. Never commit it.
- Build output (`bin/`, `obj/`) is also gitignored.
