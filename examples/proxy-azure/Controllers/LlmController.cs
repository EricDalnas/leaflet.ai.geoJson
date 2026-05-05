using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using AzureProxy.Services;

namespace AzureProxy.Controllers;

[ApiController]
[Route("api/llm")]
public class LlmController : ControllerBase
{
    private readonly GeminiService _gemini;
    private readonly RateLimiter _rateLimiter;
    private readonly RequestGuard _guard;
    private readonly ILogger<LlmController> _logger;

    public LlmController(GeminiService gemini, RateLimiter rateLimiter, RequestGuard guard, ILogger<LlmController> logger)
    {
        _gemini = gemini;
        _rateLimiter = rateLimiter;
        _guard = guard;
        _logger = logger;
    }

    [HttpOptions]
    [HttpPost]
    public async Task<IActionResult> Post()
    {
        Response.Headers.Append("Access-Control-Allow-Methods", "POST, OPTIONS");
        Response.Headers.Append("Access-Control-Allow-Headers", "Content-Type, X-Auth-Key");

        if (Request.Method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            if (!_guard.SetCors(Request, Response))
                return StatusCode((int)HttpStatusCode.Forbidden);

            return NoContent();
        }

        if (!_guard.SetCors(Request, Response))
            return StatusCode((int)HttpStatusCode.Forbidden, new { error = "Origin not allowed" });

        if (!_guard.IsAuthenticated(Request))
            return StatusCode((int)HttpStatusCode.Unauthorized, new { error = "Invalid or missing X-Auth-Key header" });

        var ip = ClientIp(Request);
        if (!_rateLimiter.IsAllowed(ip))
            return StatusCode((int)HttpStatusCode.TooManyRequests, new { error = "Rate limit exceeded. Try again shortly." });

        LlmRequest? body;
        try
        {
            using var reader = new StreamReader(Request.Body);
            var raw = await reader.ReadToEndAsync();
            if (string.IsNullOrEmpty(raw) || raw.Length > 32_768)
                return StatusCode((int)HttpStatusCode.RequestEntityTooLarge, new { error = "Request body too large" });

            body = JsonSerializer.Deserialize<LlmRequest>(raw, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch
        {
            return BadRequest(new { error = "Invalid JSON body" });
        }

        if (body is null || string.IsNullOrWhiteSpace(body.Message))
            return BadRequest(new { error = "message is required" });

        if (body.Message.Length > 8_000)
            return BadRequest(new { error = "message too long (max 8000 characters)" });

        try
        {
            var text = await _gemini.GenerateAsync(body);
            return Ok(new { text });
        }
        catch (HttpRequestException ex)
        {
            _logger.LogError(ex, "Gemini request failed");
            var status = ex.StatusCode.HasValue ? (int)ex.StatusCode : (int)HttpStatusCode.BadGateway;
            return StatusCode(status, new { error = ex.Message ?? "Gemini request failed" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error in LlmController");
            return StatusCode((int)HttpStatusCode.InternalServerError, new { error = "An unexpected error occurred" });
        }
    }

    private static string ClientIp(HttpRequest request) =>
        request.Headers.TryGetValue("X-Forwarded-For", out var fwd)
            ? fwd.FirstOrDefault()?.Split(',')[0].Trim() ?? "unknown"
            : "unknown";
}