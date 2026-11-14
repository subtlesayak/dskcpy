import https from 'node:https';

const service = 'dskcpy-browser-receiver';
export function receiverProbeTarget(descriptor, expectedOrigin) {
  try {
    const url = new URL(descriptor?.url);
    if (url.origin !== expectedOrigin || url.protocol !== 'https:' || url.pathname !== '/'
        || url.username || url.password || url.search || url.hash
        || !/^[a-z0-9.-]+\.ts\.net$/i.test(url.hostname)
        || !/^[a-f0-9]{32}$/.test(descriptor.instance)) throw Error();
    return new URL('/health', url);
  } catch { throw Error('Invalid owned receiver descriptor'); }
}

// One read-only request to the owned receiver's already-configured private
// HTTPS origin. No redirects, credentials, trust bypass, route changes or grant.
export function probePrivateReceiver(descriptor, expectedOrigin, { signal, request = https.request, timeoutMs = 4000 } = {}) {
  let target;
  try { target = receiverProbeTarget(descriptor, expectedOrigin); }
  catch { return Promise.resolve({ ready: false, reason: 'response' }); }
  return new Promise(resolve => {
    let req, response, timer, done = false;
    const finish = (ready, reason) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      response?.destroy(); req?.destroy();
      resolve(ready ? { ready: true } : { ready: false, reason });
    };
    const abort = () => finish(false, 'cancelled');
    if (signal?.aborted) { finish(false, 'cancelled'); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(false, 'timeout'), Math.max(1, Math.min(4000, timeoutMs)));
    try {
      req = request(target, { method: 'GET', agent: false, rejectUnauthorized: true,
        minVersion: 'TLSv1.2', maxHeaderSize: 4096,
        headers: { Accept: 'application/json', 'Cache-Control': 'no-store', Connection: 'close' } }, incoming => {
        response = incoming;
        if (done) { incoming.destroy(); return; }
        if (incoming.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] || '')
            || incoming.headers['content-encoding']) { finish(false, 'response'); return; }
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > 256) { finish(false, 'response'); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (done) return;
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (Object.keys(value).length !== 2 || value.service !== service || value.instance !== descriptor.instance) {
              finish(false, 'response'); return;
            }
            finish(true);
          } catch { finish(false, 'response'); }
        });
        incoming.on('error', () => finish(false, 'connect'));
        incoming.on('aborted', () => finish(false, 'connect'));
      });
      req.on('error', error => finish(false,
        /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '') ? 'certificate'
          : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'name' : 'connect'));
      req.end();
    } catch { finish(false, 'connect'); }
  });
}

export function receiverProbeMessage(reason) {
  if (reason === 'certificate') return 'The private link’s security certificate could not be verified. Open Tailscale and check its HTTPS setup, then try again. Do not bypass the browser’s security warning.';
  if (reason === 'name') return 'The private address could not be found. Check that Tailscale is connected on this computer, then try again.';
  if (reason === 'response') return 'The private link did not reach this app’s receiver. Check the dskcpy connection in Tailscale, then try again.';
  return 'The private receiver did not answer. Check that Tailscale is connected and this computer is online, then try again.';
}
