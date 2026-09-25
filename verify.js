const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const bs58 = require('bs58');

const ROOT = __dirname;
const errors = [];

function readJson(fileName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
  } catch (error) {
    errors.push(`${fileName} 无法解析：${error.message}`);
    return null;
  }
}

function stableJson(value) {
  return JSON.stringify(value);
}

function verifySources(fileName, config) {
  if (!config) return;
  if (!Number.isInteger(config.cache_time) || config.cache_time <= 0) {
    errors.push(`${fileName} 的 cache_time 必须是正整数`);
  }
  if (!config.api_site || typeof config.api_site !== 'object' || Array.isArray(config.api_site)) {
    errors.push(`${fileName} 的 api_site 必须是对象`);
    return;
  }

  const seenApis = new Map();
  for (const [key, source] of Object.entries(config.api_site)) {
    for (const field of ['name', 'api', 'detail']) {
      if (typeof source[field] !== 'string' || !source[field].trim()) {
        errors.push(`${fileName}: ${key}.${field} 必须是非空字符串`);
      }
    }
    for (const field of ['api', 'detail']) {
      try {
        const url = new URL(source[field]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议不支持');
      } catch {
        errors.push(`${fileName}: ${key}.${field} 不是有效的 HTTP(S) URL`);
      }
    }
    if (seenApis.has(source.api)) {
      errors.push(`${fileName}: ${key} 与 ${seenApis.get(source.api)} 使用重复 API`);
    }
    seenApis.set(source.api, key);
  }
}

function verifyEncoded(jsonName, encodedName) {
  try {
    const source = fs.readFileSync(path.join(ROOT, jsonName), 'utf8').replace(/\r\n/g, '\n');
    const encoded = fs.readFileSync(path.join(ROOT, encodedName), 'utf8').trim();
    const decoded = Buffer.from(bs58.decode(encoded)).toString('utf8').replace(/\r\n/g, '\n');
    if (source !== decoded) errors.push(`${encodedName} 不是 ${jsonName} 的最新编码`);
  } catch (error) {
    errors.push(`${encodedName} 验证失败：${error.message}`);
  }
}

function verifySyntax(fileName) {
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, fileName)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    errors.push(`${fileName} 语法错误：${(result.stderr || result.stdout).trim()}`);
  }
}

const full = readJson('LunaTV-config.json');
const jingjian = readJson('jingjian.json');
const jin18 = readJson('jin18.json');

verifySources('LunaTV-config.json', full);
verifySources('jingjian.json', jingjian);
verifySources('jin18.json', jin18);

if (full && jingjian) {
  const expected = {
    cache_time: full.cache_time,
    api_site: Object.fromEntries(Object.entries(full.api_site).filter(([, source]) => !source._comment)),
  };
  if (stableJson(jingjian) !== stableJson(expected)) errors.push('jingjian.json 与完整配置的筛选结果不一致');
}

if (jingjian && jin18) {
  const expected = {
    cache_time: jingjian.cache_time,
    api_site: Object.fromEntries(
      Object.entries(jingjian.api_site).filter(([, source]) => !source.name.startsWith('🔞'))
    ),
  };
  if (stableJson(jin18) !== stableJson(expected)) errors.push('jin18.json 与精简配置的筛选结果不一致');
}

verifyEncoded('LunaTV-config.json', 'LunaTV-config.txt');
verifyEncoded('jingjian.json', 'jingjian.txt');
verifyEncoded('jin18.json', 'jin18.txt');

for (const fileName of [
  'build-configs.js',
  'encode.js',
  'worker.test.js',
  'check-api.test.js',
  'check_api.js',
  'sync-upstream-config.js',
  'update_readme.js',
  'config.js',
  'web-editor/script.js',
  'CORSAPI/_worker.js',
]) {
  verifySyntax(fileName);
}

if (errors.length) {
  console.error(`❌ 验证失败（${errors.length} 项）`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('✅ 所有 JSON、衍生配置、Base58 与 JavaScript 均验证通过');
}
