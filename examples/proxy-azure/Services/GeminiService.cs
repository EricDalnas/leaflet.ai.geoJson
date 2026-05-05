using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace AzureProxy.Services;

public sealed class GeminiService
{
    private readonly IHttpClientFactory _http;
    private readonly IMemoryCache _cache;
    private readonly string _apiKey;

    private static readonly string[] AllowedPrefixes = ["gemini-", "gemma-"];
    private static readonly string[] BlockedKeywords = ["tts", "imagen", "embedding", "vision", "bison", "robotics", "computer-use"];

    public GeminiService(IHttpClientFactory http, IMemoryCache cache, IConfiguration config)
    {
        _http = http;
        _cache = cache;
        _apiKey = config["GEMINI_API_KEY"]
                  ?? throw new InvalidOperationException("GEMINI_API_KEY app setting is not configured.");
    }

    /// <summary>Returns true if a model ID is a usable text-generation model.</summary>
    public static bool IsTextModel(string? id)
    {
        if (string.IsNullOrEmpty(id)) return false;
        if (!AllowedPrefixes.Any(p => id.StartsWith(p, StringComparison.OrdinalIgnoreCase))) return false;
        if (BlockedKeywords.Any(kw => id.Contains(kw, StringComparison.OrdinalIgnoreCase))) return false;
        return true;
    }

    /// <summary>Returns a filtered, cached list of available Gemini models.</summary>
    public async Task<IReadOnlyList<ModelInfo>> GetModelsAsync()
    {
        return await _cache.GetOrCreateAsync("gemini:models", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(1);
            return await FetchModelsFromApiAsync();
        }) ?? [];
    }

    /// <summary>Sends a generate-content request to Gemini and returns the text response.</summary>
    public async Task<string> GenerateAsync(LlmRequest request)
    {
        var modelId = IsTextModel(request.Model) ? request.Model! : "gemini-2.5-flash";
        var temperature = Math.Clamp(request.Temperature ?? 0.7, 0.0, 2.0);
        var maxTokens = Math.Clamp(request.MaxTokens ?? 8192, 256, 32768);

        // Build contents array
        var contents = new List<object>();
        if (!string.IsNullOrWhiteSpace(request.SystemPrompt))
        {
            contents.Add(new { role = "user",  parts = new[] { new { text = request.SystemPrompt.Trim() } } });
            contents.Add(new { role = "model", parts = new[] { new { text = "Understood." } } });
        }
        contents.Add(new { role = "user", parts = new[] { new { text = request.Message.Trim() } } });

        var payload = new
        {
            contents,
            generationConfig = new { temperature, maxOutputTokens = maxTokens }
        };

        var client = _http.CreateClient("gemini");
        var url = $"https://generativelanguage.googleapis.com/v1beta/models/{modelId}:generateContent?key={_apiKey}";

        using var httpResponse = await client.PostAsync(url,
            new StringContent(JsonSerializer.Serialize(payload),
                System.Text.Encoding.UTF8, "application/json"));

        var json = JsonDocument.Parse(await httpResponse.Content.ReadAsStringAsync());

        if (!httpResponse.IsSuccessStatusCode)
        {
            var message = json.RootElement
                .TryGetProperty("error", out var err) && err.TryGetProperty("message", out var m)
                ? m.GetString()
                : "Gemini request failed";
            throw new HttpRequestException(message, null, httpResponse.StatusCode);
        }

        return json.RootElement
            .GetProperty("candidates")[0]
            .GetProperty("content")
            .GetProperty("parts")[0]
            .GetProperty("text")
            .GetString() ?? string.Empty;
    }

    private async Task<IReadOnlyList<ModelInfo>> FetchModelsFromApiAsync()
    {
        var client = _http.CreateClient("gemini");
        var url = $"https://generativelanguage.googleapis.com/v1beta/models?key={_apiKey}&pageSize=200";
        using var response = await client.GetAsync(url);
        response.EnsureSuccessStatusCode();

        var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        if (!json.RootElement.TryGetProperty("models", out var models)) return [];

        // Known stable model IDs
        var stableIds = new[] { "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash-lite", 
                                "gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro" };

        var items = models.EnumerateArray()
            .Where(m =>
                m.TryGetProperty("supportedGenerationMethods", out var methods) &&
                methods.EnumerateArray().Any(x => x.GetString() == "generateContent"))
            .Select(m =>
            {
                var rawName = m.GetProperty("name").GetString()!;
                var id = rawName.Replace("models/", "");
                var displayName = m.TryGetProperty("displayName", out var dn) ? dn.GetString()! : id;
                var inputTokenLimit = m.TryGetProperty("inputTokenLimit", out var itl) ? (int?)itl.GetInt32() : null;
                var outputTokenLimit = m.TryGetProperty("outputTokenLimit", out var otl) ? (int?)otl.GetInt32() : null;
                return new ModelInfo(id, displayName, inputTokenLimit, outputTokenLimit);
            })
            .Where(m => IsTextModel(m.Id))
            .ToList();

        // Sort: stable models first (in order), then others alphabetically
        items.Sort((a, b) =>
        {
            var ai = Array.IndexOf(stableIds, a.Id);
            var bi = Array.IndexOf(stableIds, b.Id);
            if (ai != -1 && bi != -1) return ai - bi;
            if (ai != -1) return -1;
            if (bi != -1) return 1;
            return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        });

        return items;
    }
}

public sealed record ModelInfo(
    [property: JsonPropertyName("id")]   string Id,
    [property: JsonPropertyName("name")] string Name,
    int? InputTokenLimit = null,
    int? OutputTokenLimit = null);

public sealed class LlmRequest
{
    [JsonPropertyName("message")]      public string  Message      { get; set; } = string.Empty;
    [JsonPropertyName("systemPrompt")] public string? SystemPrompt { get; set; }
    [JsonPropertyName("model")]        public string? Model        { get; set; }
    [JsonPropertyName("temperature")]  public double? Temperature  { get; set; }
    [JsonPropertyName("maxTokens")]    public int?    MaxTokens    { get; set; }
}
