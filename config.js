// Cloudflare Worker that powers live-on-refresh mode. Header shows
// "Live · fetched ..." when this URL is reachable; falls back to the static
// data/results.js (and shows "Last manual sync ...") if it isn't.
// Clear this string to force static mode. Update it to point at a different
// Worker (e.g. a staging deploy) without touching app.js.
window.CONFIG = {
  workerUrl: "https://wc-draft-order.rmallensb.workers.dev",
};
