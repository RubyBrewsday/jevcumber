// Runs in front of the static assets in site/: jevcumber.dev is canonical; every other hostname routed
// to this Worker (jevcumber.com, www.*) redirects to it. The *.workers.dev preview URL is left alone.
const CANONICAL = 'jevcumber.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isPreview = url.hostname.endsWith('.workers.dev') || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.hostname !== CANONICAL && !isPreview) {
      return Response.redirect(`https://${CANONICAL}${url.pathname}${url.search}`, 301);
    }

    const response = await env.ASSETS.fetch(request);
    const range = request.headers.get('Range');
    if (range && response.status === 200) return slice(response, range);
    return response;
  },
};

// The asset layer ignores Range, but Safari will not play a video without byte-range support.
// The demo is ~1 MB, so serving a range by slicing the whole asset is cheap.
async function slice(response, range) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === '' && match[2] === '')) return response;

  const body = await response.arrayBuffer();
  const size = body.byteLength;
  let start = match[1] === '' ? Math.max(size - Number(match[2]), 0) : Number(match[1]);
  let end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);

  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  if (start >= size || start > end) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
