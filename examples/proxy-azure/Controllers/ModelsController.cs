using System.Net;
using Microsoft.AspNetCore.Mvc;
using AzureProxy.Services;

namespace AzureProxy.Controllers;

[ApiController]
[Route("api/models")]
public class ModelsController : ControllerBase
{
    private readonly GeminiService _gemini;
    private readonly RateLimiter _rateLimiter;
    private readonly RequestGuard _guard;
    private readonly ILogger<ModelsController> _logger;

    public ModelsController(GeminiService gemini, RateLimiter rateLimiter, RequestGuard guard, ILogger<ModelsController> logger)
    {
        _gemini = gemini;
        _rateLimiter = rateLimiter;
        _guard = guard;
        _logger = logger;
    }

    [HttpOptions]
    [HttpGet]
    public async Task<IActionResult> Get()
    {
        Response.Headers.Append("Access-Control-Allow-Methods", "GET, OPTIONS");
        Response.Headers.Append("Access-Control-Allow-Headers", "Content-Type, X-Auth-Key");

        // Handle CORS preflight
        if (Request.Method.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            if (!_guard.SetCors(Request, Response))
                return StatusCode((int)HttpStatusCode.Forbidden);

            return NoContent();
        }

        // CORS
        if (!_guard.SetCors(Request, Response))
            return StatusCode((int)HttpStatusCode.Forbidden, new { error = "Origin not allowed" });

        // Authentication (if enabled)
        if (!_guard.IsAuthenticated(Request))
            return StatusCode((int)HttpStatusCode.Unauthorized, new { error = "Invalid or missing X-Auth-Key header" });

        // Rate limit by client IP
        var ip = ClientIp(Request);
        if (!_rateLimiter.IsAllowed(ip))
            return StatusCode((int)HttpStatusCode.TooManyRequests, new { error = "Rate limit exceeded. Try again shortly." });

        try
        {
            var models = await _gemini.GetModelsAsync();
            return Ok(models);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch models");
            return StatusCode((int)HttpStatusCode.InternalServerError, new { error = "Could not load model list from Gemini API." });
        }
    }

    private static string ClientIp(HttpRequest request) =>
        request.Headers.TryGetValue("X-Forwarded-For", out var fwd)
            ? fwd.FirstOrDefault()?.Split(',')[0].Trim() ?? "unknown"
            : "unknown";
}