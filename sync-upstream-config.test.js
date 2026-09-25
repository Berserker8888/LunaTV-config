const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  rewriteProxyHost,
  assertCatalog,
  syncUpstreamCatalog,
  UPSTREAM_CONFIG_URL,
  UPSTREAM_PROXY_HOST,
  LOCAL_PROXY_HOST,
} = require('./sync-upstream-config');

test('upstream proxy host is rewritten and other fields stay intact', () => {
  const rewritten = rewriteProxyHost({
    cache_time: 7200,
    api_site: {
      blocked: {
        name: '百度云',
        api: `https://${UPSTREAM_PROXY_HOST}/?url=https://api.example/vod`,
        detail: 'https://example.com',
      },
      direct: {
        name: '量子',
        api: 'https://cj.example/api.php/provide/vod',
      },
    },
  });

  assert.equal(rewritten.api_site.blocked.api, `https://${LOCAL_PROXY_HOST}/?url=https://api.example/vod`);
  assert.equal(rewritten.api_site.direct.api, 'https://cj.example/api.php/provide/vod');
  assert.equal(rewritten.api_site.blocked.name, '百度云');
  assert.equal(rewritten.cache_time, 7200);
});

test('catalog sync writes the rewritten upstream document', async () => {
  const outputPath = path.join(os.tmpdir(), `lunatv-sync-${Date.now()}.json`);
  const upstream = {
    cache_time: 7200,
    api_site: {
      lovedan: {
        name: '艾旦',
        api: `https://${UPSTREAM_PROXY_HOST}/?url=https://lovedan.net/api.php/provide/vod`,
        detail: 'https://lovedan.net',
      },
    },
  };
  let requestedUrl = '';
  const result = await syncUpstreamCatalog({
    outputPath,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => upstream,
      };
    },
  });

  assert.equal(requestedUrl, UPSTREAM_CONFIG_URL);
  assert.equal(result.changed, true);
  assert.equal(result.sources, 1);
  const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(saved.api_site.lovedan.api.includes(LOCAL_PROXY_HOST), true);
  assert.equal(saved.api_site.lovedan.api.includes(UPSTREAM_PROXY_HOST), false);
  fs.unlinkSync(outputPath);
});

test('empty upstream catalog is rejected', () => {
  assert.throws(() => assertCatalog({ cache_time: 7200, api_site: {} }), /空的/);
});
