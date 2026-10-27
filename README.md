# 车来了 · 附近站点实时公交

个人用的实时公交查看页：打开就是附近的站点和到站时间，30 秒自动刷新。

- **前端**：Astro 静态页，移动端优先，首屏零依赖
- **接口**：Cloudflare Pages Functions 在边缘完成签名和解密
- **部署**：GitHub → Cloudflare Pages 自动构建
- **数据**：车来了公开 H5 接口（`web.chelaile.net.cn`）

## 为什么要有这个

官方 App 广告多、要登录、要定位权限。这里只保留一个功能：**附近的公交车还有几分钟到**。

手机上打开网页、加到主屏幕，和装一个 App 没区别，但干净得多。

## 功能

- **首页**：附近站点 + 每条线的到站时间，30 秒自动刷新；定位失败回退到默认位置
- **站点页** `/station/?physicalStId=…`：该站全部线路与到站时间，可收藏站点、也可逐条收藏线路
- **线路页** `/line/?lineId=…&dir=…`：首末班 / 票价 / 站数，沿途站点列表，车辆位置用 🚌 标在对应站
- **收藏**：站点与线路都能收藏，全部存在浏览器 `localStorage`，不联网、不需要账号；首页顶部是收藏入口

## 架构

```
浏览器（Astro 静态页）
   │  GET /api/nearby   ← 首页：附近站点
   │  GET /api/station  ← 站点页：单站全部线路
   │  GET /api/line     ← 线路页：沿途站点 + 车辆位置
   ▼
Pages Function（边缘）
   ├── MD5 签名   md5(`"k"="v"&...` + salt)
   ├── 请求上游   web.chelaile.net.cn/api/…
   └── AES-256-ECB 解密响应 → 精简字段 → JSON
```

签名与解密全部在服务端完成，浏览器只拿到「站点 + 线路 + 到站时间」。

对应三个上游接口：

| 本站接口 | 上游 |
| --- | --- |
| `/api/nearby` | `bus/stop!encryptedHomePage.action` |
| `/api/station` | `bus/stop!encryptedPhyStnDetail.action` |
| `/api/line` | `bus/line!encryptedLineDetail.action` |

## 本地开发

```bash
npm install
npm run build
npx wrangler pages dev dist --port 8788   # 静态页 + Functions 一起跑
# 打开 http://localhost:8788
```

只改样式可以直接 `npm run dev`（Astro 热更新），但 `/api/*` 需要 Pages Functions，
所以调接口时用 `wrangler pages dev`。

> 注意：`wrangler pages dev` 在本机会因 workerd 创建状态目录报 `CreateDirectory: #5 拒绝访问`，
> 换英文路径、指定 `--persist-to` 都没解决。不影响部署，线上正常。

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
│   ├── chelaile.js    上游客户端：签名 / 请求 / 解密 / 三种查询
│   ├── md5.js         纯 JS MD5（不依赖运行时兼容层）
│   └── aes-ecb.js     纯 JS AES-256-ECB 解密
└── api/
    ├── nearby.js       GET /api/nearby
    ├── station.js      GET /api/station
    └── line.js         GET /api/line
src/
├── layouts/Base.astro
├── pages/
│   ├── index.astro     首页：附近站点
│   ├── station.astro   站点详情
│   └── line.astro      线路详情
├── scripts/
│   ├── util.js         转义 / 时间格式化 / 线路行渲染 / 链接构造
│   └── favs.js         收藏（localStorage）
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

**详情页是静态页 + 客户端参数**：`/station/?physicalStId=…` 这类 URL 用查询参数而不是路径段，
因为 Astro 静态输出没法为未知 id 生成动态路由；这样不用上 SSR 适配器。

**收藏不落服务端**：只写 `localStorage`，跨设备不同步，也不涉及任何账号体系。

## 边界

- 只做**只读、低频**查询，不做批量采集、不转售
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
| `busBaseIndex` / `order` | 车辆当前所在/驶向的站序 |
