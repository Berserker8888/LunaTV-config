const fs = require('fs');
const path = require('path');

const UPSTREAM_CONFIG_URL = 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/main/LunaTV-config.json';
const UPSTREAM_PROXY_HOST = 'pz.v88.qzz.io';
const LOCAL_PROXY_HOST = 'pz.berserk.qzz.io';
const OUTPUT_PATH = path.join(__dirname, 'LunaTV-config.json');
const EOL = process.platform === 'win32' ? '\r\n' : '\n';

function rewriteProxyHost(value) {
  if (typeof value === 'string') return value.replaceAll(UPSTREAM_PROXY_HOST, LOCAL_PROXY_HOST);
  if (Array.isArray(value)) return value.map(rewriteProxyHost);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteProxyHost(item)]));
  }
  return value;
}

function assertCatalog(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('上游片源必须是 JSON 对象');
  }
  if (!Number.isInteger(config.cache_time) || config.cache_time <= 0) {
    throw new Error('上游 cache_time 必须是正整数');
  }
  if (!config.api_site || typeof config.api_site !== 'object' || Array.isArray(config.api_site)) {
    throw new Error('上游 api_site 必须是对象');
  }
  if (Object.keys(config.api_site).length === 0) {
    throw new Error('上游 api_site 是空的');
  }
}

function catalogText(config) {
  return `${JSON.stringify(config, null, 2)}\n`.replace(/\n/g, EOL);
}

async function syncUpstreamCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const outputPath = options.outputPath || OUTPUT_PATH;
  const response = await fetchImpl(UPSTREAM_CONFIG_URL, {
    signal: AbortSignal.timeout(options.timeoutMs || 20000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`上游片源下载失败：HTTP ${response.status}`);

  let config;
  try {
    config = await response.json();
  } catch {
    throw new Error('上游片源不是有效 JSON');
  }
  assertCatalog(config);

  const rewritten = rewriteProxyHost(config);
  const text = catalogText(rewritten);
  const previous = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
  const sourceCount = Object.keys(rewritten.api_site).length;
  if (previous === text) {
    console.log(`上游片源没有变化（${sourceCount} 个来源）`);
    return { changed: false, sources: sourceCount };
  }

  fs.writeFileSync(outputPath, text, 'utf8');
  console.log(`已同步上游片源（${sourceCount} 个来源），代理域名改为 ${LOCAL_PROXY_HOST}`);
  return { changed: true, sources: sourceCount };
}

if (require.main === module) {
  syncUpstreamCatalog().catch((error) => {
    console.error(`片源同步失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  rewriteProxyHost,
  assertCatalog,
  syncUpstreamCatalog,
  UPSTREAM_CONFIG_URL,
  UPSTREAM_PROXY_HOST,
  LOCAL_PROXY_HOST,
};
