const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadWorker(fetchImpl = async () => new Response('{}', {
  headers: { 'Content-Type': 'application/json' },
})) {
  const workerPath = path.join(__dirname, 'CORSAPI', '_worker.js');
  const source = fs.readFileSync(workerPath, 'utf8')
    .replace('export default {', 'const worker = {')
    .concat('\nglobalThis.__worker = worker;');

  const context = {
    AbortController,
    BigInt,
    Headers,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    clearTimeout,
    console: { error() {}, log() {} },
    fetch: fetchImpl,
    setTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__worker;
}

function proxyRequest(target, init) {
  return new Request(`https://worker.test/?url=${encodeURIComponent(target)}`, init);
}

test('health endpoint is available', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(new Request('https://worker.test/health'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
});

test('unsafe methods are rejected', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(new Request('https://worker.test/', { method: 'POST' }), {});
  assert.equal(response.status, 405);
});

test('private network targets are blocked', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(proxyRequest('http://127.0.0.1/private'), {});
  assert.equal(response.status, 403);
});

test('invalid source names and prefixes return 400', async () => {
  const worker = loadWorker();
  const badSource = await worker.fetch(new Request('https://worker.test/?format=0&source=unknown'), {});
  const badPrefix = await worker.fetch(new Request('https://worker.test/?format=1&prefix=javascript:alert(1)'), {});
  assert.equal(badSource.status, 400);
  assert.equal(badPrefix.status, 400);
});

test('proxy forwards only allowlisted request headers', async () => {
  let forwardedRequest;
  const worker = loadWorker(async request => {
    forwardedRequest = request;
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  });

  const response = await worker.fetch(proxyRequest('https://api.example.com/data', {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
    },
  }), { PROXY_ALLOWED_HOSTS: 'api.example.com' });

  assert.equal(response.status, 200);
  assert.equal(forwardedRequest.headers.get('accept'), 'application/json');
  assert.equal(forwardedRequest.headers.has('authorization'), false);
  assert.equal(forwardedRequest.headers.has('cookie'), false);
});

test('redirects to private networks are blocked', async () => {
  const worker = loadWorker(async () => new Response(null, {
    status: 302,
    headers: { Location: 'http://127.0.0.1/private' },
  }));

  const response = await worker.fetch(
    proxyRequest('https://api.example.com/redirect'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  assert.equal(response.status, 502);
});

test('proxy errors redact secrets from target URLs', async () => {
  const worker = loadWorker(async () => { throw new Error('upstream failed'); });
  const response = await worker.fetch(
    proxyRequest('https://api.example.com/data?token=very-secret'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.target.includes('very-secret'), false);
});

test('health and proxy responses advertise HTTP/3', async () => {
  const worker = loadWorker();
  const health = await worker.fetch(new Request('https://worker.test/health'), {});
  assert.match(health.headers.get('alt-svc') || '', /h3=/);
});

test('extra query params are forwarded to the upstream API', async () => {
  let forwarded;
  const worker = loadWorker(async request => {
    forwarded = request;
    return new Response('{"ok":true}');
  });

  const response = await worker.fetch(
    new Request('https://worker.test/?url=' + encodeURIComponent('https://api.example.com/vod') + '&ac=videolist&wd=hello'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );

  assert.equal(response.status, 200);
  const forwardedUrl = new URL(forwarded.url);
  assert.equal(forwardedUrl.searchParams.get('ac'), 'videolist');
  assert.equal(forwardedUrl.searchParams.get('wd'), 'hello');
});

test('generic proxy still rejects hosts outside the allowlist', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(
    proxyRequest('https://cdn.example.com/ep.ts'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  assert.equal(response.status, 403);
});

test('source path /p/{id} proxies allowlisted APIs', async () => {
  let forwarded;
  const worker = loadWorker(async request => {
    forwarded = request;
    return new Response('{"list":[]}');
  });
  const response = await worker.fetch(
    new Request('https://worker.test/p/iqiyi?url=' + encodeURIComponent('https://api.example.com/vod')),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  assert.equal(response.status, 200);
  assert.equal(new URL(forwarded.url).hostname, 'api.example.com');
});

test('m3u8 endpoint rewrites segments, keys and nested playlists', async () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.key"',
    '#EXTINF:4.0,',
    'seg0.ts',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'https://cdn.example.com/high.m3u8',
    '',
  ].join('\n');

  const worker = loadWorker(async () => new Response(playlist, {
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  }));

  const response = await worker.fetch(
    new Request('https://worker.test/m3u8?url=' + encodeURIComponent('https://cdn.example.com/vod/index.m3u8')),
    {}
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.match(body, /\/seg\?url=https%3A%2F%2Fcdn\.example\.com%2Fvod%2Fseg0\.ts/);
  assert.match(body, /\/seg\?url=https%3A%2F%2Fcdn\.example\.com%2Fkey\.key/);
  assert.match(body, /\/m3u8\?url=https%3A%2F%2Fcdn\.example\.com%2Fhigh\.m3u8/);
});

test('m3u8 endpoint rejects HTML disguised as a playlist', async () => {
  const worker = loadWorker(async () => new Response('<html>login</html>', {
    headers: { 'Content-Type': 'text/html' },
  }));
  const response = await worker.fetch(
    new Request('https://worker.test/m3u8?url=' + encodeURIComponent('https://cdn.example.com/index.m3u8')),
    {}
  );
  assert.equal(response.status, 415);
});

test('m3u8 endpoint blocks private network targets', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(
    new Request('https://worker.test/m3u8?url=' + encodeURIComponent('http://127.0.0.1/live.m3u8')),
    {}
  );
  assert.equal(response.status, 403);
});

test('rewritten m3u8 is served from KV on the second request', async () => {
  const playlist = '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example.com/a.ts\n';
  let upstreamHits = 0;
  const store = new Map();
  const kv = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
  const pending = [];
  const worker = loadWorker(async () => {
    upstreamHits += 1;
    return new Response(playlist);
  });

  const request = new Request(
    'https://worker.test/m3u8?url=' + encodeURIComponent('https://cdn.example.com/index.m3u8')
  );
  const env = { CONFIG_KV: kv };
  const ctx = { waitUntil(promise) { pending.push(promise); } };

  const miss = await worker.fetch(request, env, ctx);
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('x-cache'), 'MISS');
  await Promise.all(pending);
  assert.equal(upstreamHits, 1);

  const hit = await worker.fetch(request, env, ctx);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-cache'), 'HIT');
  assert.equal(upstreamHits, 1);
  assert.match(await hit.text(), /\/seg\?url=/);
});

test('segment proxy allows public media hosts that are not CMS sources', async () => {
  let forwarded;
  const worker = loadWorker(async request => {
    forwarded = request;
    return new Response(new Uint8Array([0, 1, 2]), {
      headers: { 'Content-Type': 'video/mp2t' },
    });
  });
  const response = await worker.fetch(
    new Request('https://worker.test/seg?url=' + encodeURIComponent('https://cdn.example.com/a.ts')),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  assert.equal(response.status, 200);
  assert.equal(new URL(forwarded.url).pathname, '/a.ts');
});

test('format=1 uses per-source /p/{id} proxy paths', async () => {
  const worker = loadWorker(async () => new Response(JSON.stringify({
    cache_time: 7200,
    api_site: {
      iqiyi: {
        name: 'iqiyi',
        api: 'https://iqiyizyapi.com/api.php/provide/vod',
      },
    },
  })));
  const response = await worker.fetch(
    new Request('https://worker.test/?format=1&source=full'),
    {}
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.api_site.iqiyi.api, /^https:\/\/worker\.test\/p\/iqiyi\?url=https:\/\/iqiyizyapi\.com\//);
});
