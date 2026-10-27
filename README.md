# 车来了 · 附近站点实时公交

个人用的实时公交查看页：打开就是附近的站点和到站时间，30 秒自动刷新。

- **前端**：Astro 静态页，移动端优先，首屏零依赖
- **接口**：Cloudflare Pages Functions（`/api/nearby`）在边缘完成签名和解密
- **部署**：GitHub → Cloudflare Pages 自动构建
- **数据**：车来了公开 H5 接口（`web.chelaile.net.cn`）

## 为什么要有这个

官方 App 广告多、要登录、要定位权限。这里只保留一个功能：**附近的公交车还有几分钟到**。

手机上打开网页、加到主屏幕，和装一个 App 没区别，但干净得多。

## 架构

```
浏览器（Astro 静态页）
   │  GET /api/nearby?lat=&lng=&cityId=040
   ▼
Pages Function（边缘）
   ├── MD5 签名   md5(`"k"="v"&...` + salt)
   ├── 请求上游   web.chelaile.net.cn/api/bus/stop!encryptedHomePage.action
   └── AES-256-ECB 解密响应 → 精简字段 → JSON
```

签名与解密全部在服务端完成，浏览器只拿到「站点 + 线路 + 到站时间」。

## 本地开发

```bash
npm install
npm run build
npx wrangler pages dev dist --port 8788   # 静态页 + Functions 一起跑
# 打开 http://localhost:8788
```

只改样式可以直接 `npm run dev`（Astro 热更新），但 `/api/nearby` 需要 Pages Functions，
所以调接口时用 `wrangler pages dev`。

## 部署

仓库接上 Cloudflare Pages：

| 项 | 值 |
| --- | --- |
| 构建命令 | `npm run build` |
| 输出目录 | `dist` |
| 生产分支 | `main` |

`functions/` 目录会被 Pages 自动识别成 Functions，不需要额外配置。

## 目录

```
functions/
├── _lib/
│   ├── chelaile.js    上游客户端：签名 / 请求 / 解密 / 精简
│   ├── md5.js         纯 JS MD5（不依赖运行时兼容层）
│   └── aes-ecb.js     纯 JS AES-256-ECB 解密
└── api/nearby.js      GET /api/nearby
src/
├── layouts/Base.astro
├── pages/index.astro  单页应用
└── styles/global.css
```

## 实现要点

**AES-256-ECB 是必须自己实现的**：WebCrypto 只提供 CBC/CTR/GCM，而 CBC 会校验 PKCS#7
填充，直接解 ECB 密文必然抛错；Workers 的 `node:crypto` 是否支持 ECB 取决于兼容层版本，
不适合当唯一依赖。`functions/_lib/aes-ecb.js` 是带密钥扩展的完整 AES-256 解密实现，
已与 `node:crypto` 逐字节对拍。

**MD5 同理**：WebCrypto 不提供 MD5，这里用纯 JS 实现（同样对拍验证过）。

**上游会校验客户端特征**：`User-Agent`、`Referer`、`xweb_xhr` 等请求头必须与微信小程序
一致，否则即使签名正确也会返回 `status:400`。

## 边界

- 只做**只读、低频**的「附近站点」查询，不做批量采集、不做转售
- 走的是未公开接口，属于灰色地带：上游改签名就会失效，需要回来同步更新
- 接口可能随时变更，失效时优先看 `functions/_lib/chelaile.js` 里的参数与路径

## 数据字段速查

| 字段 | 含义 |
| --- | --- |
| `travelTime` | 到站剩余秒数，`-1` 表示暂无数据 |
| `distanceToDest` | 距目标站距离（米） |
| `capacity` | 拥挤度（0 未知 / 1 / 2） |
| `arrivalTime` | 预计到站时间戳（毫秒） |
| `value` | 还有几站（部分线路为空） |
| `preArrivalTime` | 未发车时的预计发车时刻 |
