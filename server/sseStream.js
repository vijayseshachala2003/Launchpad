/**
 * Server-Sent Events helpers for long-running POST streams.
 * Periodic SSE comments keep HTTP/2 and reverse proxies from closing idle connections
 * (fixes net::ERR_HTTP2_PROTOCOL_ERROR in some Chrome + nginx/Cloudflare setups).
 */

export function setupSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  // Avoid Content-Length so Node uses chunked encoding (required for streaming).
  if (typeof res.removeHeader === 'function') {
    res.removeHeader('Content-Length');
  }
}

/**
 * @param {import('http').ServerResponse} res
 * @param {number} intervalMs
 * @returns {() => void} call before res.end() to stop pings
 */
export function attachSseKeepalive(res, intervalMs = 12000) {
  let timer = null;

  const ping = () => {
    if (res.writableEnded) return;
    try {
      res.write(': ping\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch {
      /* client gone */
    }
  };

  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(ping, intervalMs);
  ping();
  res.once('close', stop);
  res.once('finish', stop);
  return stop;
}
