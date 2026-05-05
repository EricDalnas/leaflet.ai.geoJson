namespace AzureProxy.Services;

/// <summary>
/// Centralises CORS enforcement and authentication for ASP.NET Core.
/// </summary>
public sealed class RequestGuard
{
    private readonly string _allowedOrigin;
    private readonly string? _authKey;

    public RequestGuard(IConfiguration config)
    {
        _allowedOrigin = (config["ALLOWED_ORIGIN"] ?? string.Empty).Trim();
        var key = (config["AUTH_KEY"] ?? string.Empty).Trim();
        _authKey = string.IsNullOrEmpty(key) ? null : key;
    }

    /// <summary>
    /// Adds CORS headers. Returns false if the origin is not permitted.
    /// </summary>
    public bool SetCors(HttpRequest req, HttpResponse res)
    {
        var origin = req.Headers.TryGetValue("Origin", out var ov) ? ov.FirstOrDefault() : null;

        if (!string.IsNullOrEmpty(_allowedOrigin))
        {
            var isLocalhost = origin is not null &&
                              (origin.StartsWith("http://localhost", StringComparison.Ordinal) ||
                               origin.StartsWith("http://127.0.0.1", StringComparison.Ordinal));

            if (origin == _allowedOrigin || isLocalhost)
            {
                res.Headers["Access-Control-Allow-Origin"] = origin!;
                res.Headers["Vary"] = "Origin";
                return true;
            }

            return false; // not in allowlist
        }

        // No restriction configured → allow all (suitable when AUTH_KEY is set)
        res.Headers["Access-Control-Allow-Origin"] = "*";
        return true;
    }

    /// <summary>
    /// Returns true if the request is authenticated, or if AUTH_KEY is not configured.
    /// </summary>
    public bool IsAuthenticated(HttpRequest req)
    {
        if (_authKey is null) return true;
        return req.Headers.TryGetValue("X-Auth-Key", out var key) && key == _authKey;
    }
}
