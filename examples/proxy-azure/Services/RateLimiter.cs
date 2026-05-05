using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace AzureProxy.Services;

/// <summary>
/// Fixed-window rate limiter with per-minute and per-day limits.
/// </summary>
public sealed class RateLimiter
{
    private readonly IMemoryCache _cache;
    private readonly int _maxPerMinute;
    private readonly int _maxPerDay;
    private readonly int _globalMaxPerDay;

    public RateLimiter(IMemoryCache cache, IConfiguration config)
    {
        _cache = cache;
        _maxPerMinute = int.TryParse(config["RATE_LIMIT_RPM"], out var rpm) && rpm > 0 ? rpm : 5;
        _maxPerDay = int.TryParse(config["RATE_LIMIT_PER_IP_PER_DAY"], out var rpd) && rpd > 0 ? rpd : 50;
        _globalMaxPerDay = int.TryParse(config["RATE_LIMIT_GLOBAL_PER_DAY"], out var gpd) && gpd > 0 ? gpd : 500;
    }

    /// <summary>Returns true if the caller is within all rate limits.</summary>
    public bool IsAllowed(string clientId)
    {
        // Check global daily limit (all users combined)
        var globalKey = $"rl:global:{DateTime.UtcNow:yyyy-MM-dd}";
        var globalBucket = _cache.GetOrCreate(globalKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromDays(1);
            return new Bucket();
        })!;

        if (globalBucket.Count >= _globalMaxPerDay) return false;

        // Check per-IP daily limit
        var dailyKey = $"rl:daily:{clientId}:{DateTime.UtcNow:yyyy-MM-dd}";
        var dailyBucket = _cache.GetOrCreate(dailyKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromDays(1);
            return new Bucket();
        })!;

        if (dailyBucket.Count >= _maxPerDay) return false;

        // Check per-minute limit
        var bucket = _cache.GetOrCreate($"rl:{clientId}", entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(1);
            return new Bucket();
        })!;

        if (bucket.Count >= _maxPerMinute) return false;

        Interlocked.Increment(ref bucket.Count);
        Interlocked.Increment(ref dailyBucket.Count);
        Interlocked.Increment(ref globalBucket.Count);
        return true;
    }

    private sealed class Bucket
    {
        public int Count;
    }
}
