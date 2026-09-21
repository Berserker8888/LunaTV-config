# API 代理 & JSON 订阅器

这是一个基于 **Cloudflare Workers** 的来源白名单代理 + JSON 配置前缀替换工具。

支持将 API 请求通过 Worker 转发，并自动为 JSON 配置中的 `api` 字段添加/替换前缀。

同时支持生成 **Base58 编码的订阅格式**，并提供**多种配置源选择**，方便在外部应用中快速使用。

---

## ✨ 功能特性

### 1. 配置来源 API 代理

使用 `?url=` 参数转发配置中已登记的 API 请求。默认仅允许 `GET`、`HEAD` 与 `OPTIONS`，并阻挡本机及私有网络地址。`format=1/3` 会给每个源生成 `/p/{sourceId}?url=` 路径，避免缓存互相污染。

**示例：**

```
https://<你的域名>/?url=https://ikunzyapi.com/api.php/provide/vod/
https://<你的域名>/p/ikun?url=https://ikunzyapi.com/api.php/provide/vod/
```

### 1b. 播放流加速（m3u8）

直连失败或源站限速时，把播放地址交给 Worker：

```
https://<你的域名>/m3u8?url=<编码后的m3u8地址>
```

- 清单里的 `.ts` / 密钥 / MAP 会改写到 `/seg?url=`
- 嵌套 playlist 会改写到 `/m3u8?url=`
- `/m3u8` 与 `/seg` 只开放公网 HTTP(S)，仍阻挡本机与私有网段
- 普通 `/?url=` **不会**因此变成开放代理，CMS 接口仍走白名单
- 绑定 KV 后，改写结果缓存 5 分钟；`?nocache=1` 可跳过
- 响应头带 `Alt-Svc: h3=":443"`，客户端可升级 HTTP/3

### 2. 多配置源支持

使用 `?source=` 参数选择不同的资源配置：

- **`source=jin18`** - 精简版（27个资源，仅普通内容）
- **`source=jingjian`** - 精简+成人版（48个资源）
- **`source=full`** - 完整版（72个资源，**默认**）

### 3. 统一的 format 参数

使用 `?format=` 参数控制输出格式（合并了原来的 config 和 encode 参数）：

- **`format=0`** 或 **`format=raw`** - 原始 JSON
- **`format=1`** 或 **`format=proxy`** - 添加代理前缀的 JSON
- **`format=2`** 或 **`format=base58`** - 原始 JSON 的 Base58 编码
- **`format=3`** 或 **`format=proxy-base58`** - 代理前缀 JSON 的 Base58 编码

**示例：**

```jsx
// 获取带代理前缀的 JSON
https://<你的域名>/?format=1&source=jin18

// 获取代理 Base58 编码订阅
https://<你的域名>/?format=3&source=full
```

### 4. 动态示例生成

HTML 页面会根据当前域名自动生成示例链接，无需手动修改

---

## 🚀 部署方法

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 新建一个 **Workers & Pages → Worker**
3. 将 `_worker.js` 代码粘贴到编辑器中
4. 保存并部署
5. 在 Cloudflare Workers KV 中创建命名空间并绑定为 `CONFIG_KV`（可选，但建议启用缓存）
6. 如需代理配置以外的来源，设置 `PROXY_ALLOWED_HOSTS` 环境变量，使用逗号分隔域名，例如 `api.example.com,*.example.net`
7. 绑定自定义域名（可选）

---

## 🔗 使用示例

假设你的 Worker 部署在：[`https://api.example.workers.dev`](https://api.example.workers.dev)

### 示例 1：代理配置中的 API

```
https://api.example.workers.dev/?url=https://ikunzyapi.com/api.php/provide/vod/
```

### 示例 2：获取原始 JSON 配置（精简版）

```jsx
https://api.example.workers.dev/?format=0&source=jin18
```

### 示例 3：获取带代理前缀的 JSON 配置（完整版）

```jsx
https://api.example.workers.dev/?format=1&source=full
```

### 示例 4：获取原始 Base58 编码（精简+成人版）

```jsx
https://api.example.workers.dev/?format=2&source=jingjian
```

### 示例 5：获取代理 Base58 编码订阅（完整版）

```jsx
https://api.example.workers.dev/?format=3&source=full
```

### 示例 6：自定义代理前缀

```jsx
https://api.example.workers.dev/?format=1&source=full&prefix=https://my-proxy.com/?url=
```

### 示例 7：播放流 m3u8 加速

```
https://api.example.workers.dev/m3u8?url=https://cdn.example.com/index.m3u8
```

---

## 🛠️ 参数说明

| 参数     | 说明             | 可选值                          | 示例         |        
| -------- | ---------------- | ------------------------------- | ------------ |
| `url`    | 代理白名单 API 请求 | 配置内来源或 `PROXY_ALLOWED_HOSTS` 中的 HTTP(S) URL | `?url=https://...` |
| `format` | 配置模式         | `0 或 raw = 原始 JSON`  `1 或 proxy = 添加代理前缀`  `2 或 base58 = 原始 Base58`  `3 或 proxy-base58 = 代理 Base58` | `?format=0` |
| `source` | 配置源选择       | `jin18` = 精简版`jingjian` = 精简+成人`full` = 完整版） | `?source=jin18` |
| `prefix` | 自定义代理前缀   | 任意代理地址                      | `?prefix=https://.../?url=` |

---

## 📦 配置源对比

| 配置源 | 资源数量 | 包含成人内容 | 适用场景 |
| --- | --- | --- | --- |
| **jin18** | 27个 | ❌ 否 | 家庭使用、轻量级应用 |
| **jingjian** | 48个 | ✅ 是 | 个人使用、中等需求 |
| **full** | 72个 | ✅ 是 | 完整功能、最大兼容性 |

---

## 📋 完整订阅链接模板

将 `\<你的域名\>` 替换为你的实际 Worker 地址：

### 精简版（jin18）

```jsx
# 原始 JSON
https://<你的域名>/?format=0&source=jin18

# 带代理前缀的 JSON
https://<你的域名>/?format=1&source=jin18

# 原始 Base58 编码
https://<你的域名>/?format=2&source=jin18

# 代理 Base58 编码（推荐用于订阅）
https://<你的域名>/?format=3&source=jin18
```

### 精简+成人版（jingjian）

```jsx
# 原始 JSON
https://<你的域名>/?format=0&source=jingjian

# 带代理前缀的 JSON
https://<你的域名>/?format=1&source=jingjian

# 原始 Base58 编码
https://<你的域名>/?format=2&source=jingjian

# 代理 Base58 编码（推荐用于订阅）
https://<你的域名>/?format=3&source=jingjian
```

### 完整版（full，默认）

```jsx
# 原始 JSON
https://<你的域名>/?format=0&source=full

# 带代理前缀的 JSON
https://<你的域名>/?format=1&source=full

# 原始 Base58 编码
https://<你的域名>/?format=2&source=full

# 代理 Base58 编码（推荐用于订阅）
https://<你的域名>/?format=3&source=full
```

---

## 📌 注意事项

- **Workers 免费额度**：每天 10 万次请求，适合轻量使用。超出后需升级付费套餐。
- **代理替换逻辑**：如果 JSON 中 `api` 字段已包含 `?url=` 前缀，会先去掉旧前缀，再加上新前缀。
- **Base58 输出**：适合直接作为订阅链接在支持该格式的客户端中使用。
- **配置源更新**：配置源来自 GitHub；启用 KV 时 Worker 快取为 1800 秒（30 分钟），配置内的 `cache_time: 7200` 是客户端建议刷新周期。
- **代理限制**：`/?url=` 默认只允许配置内已登记的来源。播放流请用 `/m3u8`，不要把 `PROXY_ALLOWED_HOSTS` 设为 `*`。
- **KV 缓存**：`CONFIG_KV` 或 `KV` 绑定后，JSON 配置缓存 30 分钟，改写后的 m3u8 缓存 5 分钟。
- **超时**：API 9 秒，m3u8 15 秒，分片 30 秒。
- **CORS 支持**：已启用 GET/HEAD 读取所需的 CORS 支持，可直接在前端应用中调用。

---

## 🔧 高级配置

### 修改配置源地址

在 `_worker.js` 中找到 `JSON_SOURCES` 对象并修改：

```jsx
const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/your-repo/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/your-repo/jingjian.json',
  'full': 'https://raw.githubusercontent.com/your-repo/full.json'
}
```

### 修改超时时间

找到以下代码并修改超时毫秒数：

```jsx
const timeoutId = setTimeout(() => controller.abort(), 9000) // 改为其他值
```

### 扩充代理来源白名单

在 Worker 环境变量中设置 `PROXY_ALLOWED_HOSTS`，多个规则以逗号分隔，并支持 `*.example.com` 形式的子域名规则。设置为 `*` 会恢复任意公网主机代理，不建议用于公开服务。

### 添加访问日志

可以在代码中添加日志记录：

```jsx
console.log(`Request from: ${request.headers.get('cf-connecting-ip')}`)
```

---

## ❓ 常见问题

### Q: 如何查看我的 Worker 地址？

A: 部署后在 Cloudflare Dashboard 的 Workers 页面可以看到，格式通常为 [`https://worker-name.your-subdomain.workers.dev`](https://worker-name.your-subdomain.workers.dev)

### Q: 可以绑定自定义域名吗？

A: 可以！在 Worker 设置中点击「Triggers」→「Add Custom Domain」，添加你的域名即可。

### Q: 为什么返回 502 错误？

A: 可能是目标 API 超时或无法访问，检查目标 URL 是否正确，或者尝试增加超时时间。

### Q: Base58 编码后如何解码？

A: 需要使用支持 Base58 解码的库或客户端，解码后即可得到原始 JSON 配置。

### Q: 配置源多久更新一次？

A: 根据 JSON 中的 `cache_time: 7200`（秒），建议客户端每 2 小时刷新一次配置。

---

## 📄 许可证

MIT License - 自由使用、修改和分发

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 改进此项目！

---

⭐ **如果这个项目对你有帮助，请给个 Star 支持一下！**
