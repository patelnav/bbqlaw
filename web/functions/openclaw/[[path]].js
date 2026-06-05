// Serve the OpenClaw feed shell for any /openclaw or /openclaw/<token> path.
// Each pairing gets a unique non-guessable URL (bbqlaw.app/openclaw/<readerToken>);
// the page reads the token from the path and fetches that cook's live readings.
export async function onRequest(context) {
  const { request, env } = context;
  const origin = new URL(request.url).origin;
  return env.ASSETS.fetch(new URL("/openclaw/index.html", origin));
}
