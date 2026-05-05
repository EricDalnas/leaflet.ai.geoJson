using AzureProxy.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container
builder.Services.AddControllers();
builder.Services.AddMemoryCache();

// Add HttpClient for GeminiService
builder.Services.AddHttpClient("gemini", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.Add("User-Agent", "leaflet-ai-geojson-proxy/1.0");
});

builder.Services.AddSingleton<GeminiService>();
builder.Services.AddSingleton<RateLimiter>();
builder.Services.AddSingleton<RequestGuard>();

var app = builder.Build();

app.UseRouting();
app.UseAuthorization();
app.MapControllers();

app.Run();
