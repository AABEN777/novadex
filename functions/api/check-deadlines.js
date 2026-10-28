export async function onRequest(context) {
  const { request, env } = context;

  // Temporary debug — remove later
  return new Response(JSON.stringify({
    success: true,
    hasCronSecret: !!env.CRON_SECRET,
    cronSecretLength: env.CRON_SECRET ? env.CRON_SECRET.length : 0,
    authHeader: request.headers.get("authorization") || null,
    message: "Auth check disabled for testing"
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
