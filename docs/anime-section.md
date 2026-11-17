# 番剧板块：设计与分阶段计划

> 状态：**方案待确认，尚未写代码**
>
> 目标：在 litearti 里新增「番剧」板块，把 Kazumi（Flutter 番剧采集客户端）的核心能力搬过来，
> 但**沿用 litearti 自己的架构与设计系统**，而不是嵌一个 Kazumi 进去。

---

## 零、先说清楚边界

### 0.1 本期做什么（你已确认的 MVP）

```
选择番剧源 → 搜索 → 详情（封面/简介/线路/剧集）→ 选集 → 在线播放
```

### 0.2 本期明确不做

按 litearti 的惯例（README「明确没做的」），这些**不留半成品入口**：

- 弹幕（弹弹play）
- 追番列表 / 收藏
- 离线下载（m3u8 分片落盘）
- 投屏（DLNA）、外部播放器、SyncPlay 一起看
- Anime4K 超分
- 反爬虫验证码 WebView 流程
- WebView 嗅探取流（详见 §4.4，列为后续可选阶段）

### 0.3 为什么不直接移植 Kazumi 的代码

| | Kazumi | litearti |
|---|---|---|
| 语言/框架 | Dart + Flutter | TypeScript + Vue 3 + Tauri 2 |
| 规则选择器 | XPath（仅 `//` 开头） | JSONPath / CSS / 受限 JS |
| 网络出口 | dio + 自研 ECH 传输 | `net.rs` 单一出口 |
| 播放 | media_kit（原生，私有 fork） | WebView `<video>` |
| 状态 | MobX + Modular | Pinia + 显式导航 |

**没有一行能直接抄。** 能搬的是：规则字段的语义、反爬/多线路的经验、播放器的交互层次。
代码层面是「重写同一个设计」，这一点要在预期上对齐。

---

## 一、总体架构

### 1.1 数据流

```
                       ┌──────────────── 已有，复用 ────────────────┐
  番剧源 JSON ──validateSource()──> 书源存储（sources/ 同一个文件）
                       │
                       ▼
               SourceEngine（扩展后）
                 ├─ search()      搜索页 → 列表
                 ├─ detail()      详情页 → 元信息 + 线路 + 剧集
                 └─ episode()     剧集页 → 视频地址（m3u8 / mp4）
                       │
                       ▼
            ┌────────── 新增 ──────────┐
            │  AnimePlayerView          │
            │   <video> + hls.js        │
            │   src = kazumi-stream://  │
            └───────────┬──────────────┘
                        ▼
            ┌────────── 新增 ──────────┐
            │  proto.rs 流式代理        │
            │  带 Referer/UA 转发       │
            │  m3u8 重写 + Range 透传   │
            └───────────┬──────────────┘
                        ▼
                     目标站点
```

关键点：**播放不走 IPC，走自定义 URI scheme。** 理由见 §4.1。

### 1.2 新增 / 改动的文件

```
新增
  src/sources/video.ts              ← 视频规则类型 + 播放地址解析
  src/sources/videoEngine.ts        ← episode() / 取流（或并入 engine.ts，见 §2.4）
  src/views/AnimeBrowseView.vue     ← 搜索 + 结果网格
  src/views/AnimeDetailView.vue     ← 详情 + 线路 + 剧集
  src/views/AnimePlayerView.vue     ← 全窗口播放器
  src/components/AnimeCard.vue      ← 番剧卡片（复用 SourceCard 视觉语言）
  src/stores/anime.ts               ← 番剧导航状态 + 播放进度
  src/players/hlsLoader.ts          ← hls.js 自定义 loader（走 Rust 代理）
  src-tauri/src/stream.rs           ← 流式代理核心（m3u8 重写、Range）
  src-tauri/src/proto.rs            ← 自定义 scheme 注册
  scripts/convert-kazumi-plugin.mjs ← Kazumi 规则 → litearti 源
  scripts/verify-video-schema.mjs   ← 校验器测试
  scripts/verify-m3u8-rewrite.mjs   ← m3u8 重写测试
  scripts/verify-kazumi-convert.mjs ← 转换器测试
  docs/anime-section.md             ← 本文件
  docs/kazumi-rule-conversion.md    ← 两种规则的字段级对照（§5）

改动
  src/sources/schema.ts             ← 加 xpath: 前缀、video 块、video 类型校验
  src/sources/selector.ts           ← 加 XPath 求值
  src/sources/engine.ts             ← detail 返回线路，新增 episode()
  src/components/AppSidebar.vue     ← 加「番剧」导航项
  src/App.vue                       ← 番剧板块的四个屏幕与导航栈
  src/api/library.ts                ← 新增 streamUrl / episode 相关封装（若需要）
  src/i18n/index.ts                 ← 新增文案 key
  src-tauri/src/lib.rs              ← 注册 scheme、注册新 command
  src-tauri/Cargo.toml              ← 无新依赖（reqwest 已有）
  package.json                      ← 加 hls.js（见 §7 问题 1）
  README.md / docs/project-overview.md ← 同步能力说明
```

---

## 二、规则层：扩展现有 schema

### 2.1 新增 `xpath:` 前缀

在 `SELECTOR_PREFIXES` 里加 `'xpath:'`。求值几乎零成本——浏览器自带：

```ts
document.evaluate(expr, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
```

**属性取值不能用 `@attr` 后缀。** XPath 谓词里本来就有 `@`：

```xpath
//div[@class="list"]        ← 最后一个 @ 在谓词里，用 lastIndexOf('@') 会切错
```

所以 XPath 用函数式标记：

| 语法 | 含义 |
|---|---|
| `xpath://div[@class="item"]` | 节点文本 |
| `xpath://a[@class="title"]/::attr(href)` | 节点属性 |
| `xpath:` | 整个 `body` 的文本（与 CSS 空选择器一致） |

这条差异必须写进文档，否则写规则的人一定会踩。

### 2.2 新增 `video` 块

`RESOURCE_TYPES` 里 `video` 已经存在，但没有任何实现。给 `BookSource` 加一个可选块：

```ts
/** 番剧源专用的剧集与取流配置。与 chapter 互斥：文本源用 chapter，视频源用 video。 */
export interface VideoConfig {
  /**
   * 线路（road）列表选择器。一条线路 = 一个播放源。
   * 省略时视为单线路，直接在当前页取 episodes。
   */
  roads?: string
  /** 线路名称，在 roads 元素内取；省略则用「线路 1」「线路 2」。 */
  roadsName?: string
  /** 剧集列表选择器。有 roads 时在每条线路元素内取。 */
  episodes: string
  /** 剧集名称。省略则用「第 N 集」。 */
  episodeTitle?: string
  /** 剧集链接（详情/播放页地址）。 */
  episodeUrl: string
  /** 从剧集页到视频地址的解析方式。 */
  playback: PlaybackConfig
}

/** 取流策略。三种形态覆盖绝大多数站点。 */
export type PlaybackConfig =
  /** 剧集页 HTML 里直接能取到 m3u8/mp4（多数站把地址写在内联 script 里）。 */
  | { kind: 'direct'; url: string }
  /** 剧集页有个播放页地址，先进去再取。 */
  | { kind: 'page'; pageUrl: string; url: string }
  /** 地址在 JS 里拼不出来，用正则从页面源码里捞。 */
  | { kind: 'regex'; pattern: string; group?: number }

/** JSON 接口返回播放地址的形态（对应 Kazumi 的 API 规则）。 */
export interface VideoApiConfig {
  url: string                 // 模板，支持 {{id}} {{url}} {{keyword}} {{page}}
  method: 'GET' | 'POST'
  body?: string
  /** 从 JSON 里取 m3u8/mp4 地址的 JSONPath。 */
  urlPath: string
}
```

`VideoConfig.playback` 再加一个 `kind: 'api'`，用 `VideoApiConfig`，即可覆盖 Kazumi 的
`chapterMode: api` 那一路。

### 2.3 校验器要加的规则

沿用 `Issues` 手写校验器的风格（错误中文化）：

- `type` 必须是 `video` 才能有 `video` 块；反之 `type: video` 必须有 `video` 块（或至少 `episodes`）。
- `type != video` 时不允许出现 `video` 块 —— 报「`video` 只用于视频源」。
- `xpath:` 选择器要做前缀与括号的粗校验；`.//` 与 `//` 之外的形式给出警告级提示（不做硬失败）。
- `regex` 的 `pattern` 必须能 `new RegExp()` 成功。
- `playback.kind` 之外的枚举值直接拒绝。

### 2.4 引擎扩展的最小改动

`SourceEngine` 是**按 source 实例化、带 sandbox 生命周期**的类，直接在其中加方法比新建 engine 更省事，
也避免两套 sandbox 管理。建议：

```ts
/** 详情页 + 线路 + 剧集。文本源继续走 detail()。 */
async videoDetail(detailUrl: string): Promise<VideoDetail>

/** 剧集页 → 视频地址。已解析好的直链，不是可播放 URL。 */
async episodeVideoUrl(episodeUrl: string): Promise<string>
```

`detail()` 保持不动（文本源行为不变），尽量不动已有测试的断言。

---

## 三、Rust 侧：流式代理

### 3.1 为什么不用 IPC

`invoke` 每取一个分片就是一次序列化往返。HLS 一个 20 分钟视频要几百个分片，
IPC 会成为主要开销；而且 `<video src>` 根本没办法走 `invoke`。

### 3.2 自定义 URI scheme

```
kazumi-stream://localhost/stream?u=<base64url(目标)>&r=<base64url(referer)>&ua=<base64url(UA)>
```

> Windows 上 Tauri 实际把它映射成 `http://kazumi-stream.localhost/...`，
> 前端拿到的是 `convertFileSrc` 风格的绝对地址，不关心这层差异。

**为什么把 referer/UA 编码在 URL 里而不是后端存会话**：播放是纯函数式的，一个 URL 自带全部上下文，
不会因为「切换了剧集但后端还留着上一集的 header」而串味。缺点是 URL 会变长，可接受。

### 3.3 必须实现的四件事

1. **协议与主机重校验**：目标只允许 http/https；重定向每一跳重新校验（复用 `net.rs` 的
   `ensure_web_url` 思路，建议抽成公共函数）。
2. **m3u8 重写**：`Content-Type` 是 `application/vnd.apple.mpegurl`、或 URL 以 `.m3u8` 结尾、
   或 body 以 `#EXTM3U` 开头时，把 playlist 里所有子地址（分片、master 里的子 playlist、
   `#EXT-X-KEY:URI=`、`#EXT-X-MAP:URI=`、`#EXT-X-MEDIA:URI=`）都改成回流代理的 URL。
   **相对地址先按 playlist 自身 URL 解析成绝对地址再重写**——这是最容易出 bug 的地方。
3. **Range 透传**：mp4 拖动进度需要 206。转发 `Range` 请求头，回传 `Content-Range` 与 206 状态。
4. **上限**：playlist 2 MB；单个分片 64 MB；整体并发 4；单请求 30 s 超时。
   超限返回明确错误而不是静默截断。

### 3.4 安全边界怎么写进文档

`net.rs` 的头注释把「只有 GET/POST、只有 http(s)、10 MB、无 cookie」讲得很清楚。
新增通道必须同样坦白：

- 新增的是**回放通道**，不是通用代理解锁。
- 仍然只有 GET（播放不需要 POST）。
- 仍然只允许 http/https，重定向逐跳校验。
- 仍然**不接 cookie**：播放地址若是登录态专属，本期不支持（Kazumi 靠 WebView 带 cookie，我们没有）。
- 体积上限从 10 MB 提到「分片 64 MB」，因为视频分片天然超 10 MB。这是**唯一被放宽的约束**，
  且只在这条通道上。

### 3.5 CORS

自定义 scheme 的响应要带 `Access-Control-Allow-Origin: *`，否则 hls.js 的 XHR 会被拦。
`<video>` 本身不需要，但 hls.js 的 loader 需要。

---

## 四、播放器

### 4.1 形态

HTML5 `<video>` + hls.js：

- **原生 HLS**（Safari/iOS、部分 Android WebView）：直接 `video.src = url`，不加载 hls.js。
- **其他**（Windows WebView2、Linux WebKitGTK）：`Hls.isSupported()` → `hls.attachMedia()`。
- **mp4 直链**：不碰 hls.js。
- 地址如果是 `m3u8` 但我们判断失败，降级提示「该源可能已失效」。

### 4.2 交互（借鉴 Kazumi，但落在 litearti 的视觉语言里）

Kazumi 的播放器层次是：中央大播放键 / 底部进度条 + 时间 / 右侧功能簇 / 顶部返回与标题。
litearti 的约束是「无品牌色、层次靠间距与对比、图标按钮尽量带文字」。

落地取舍：

| 元素 | 做法 |
|---|---|
| 底部控制条 | 进度条在上、按钮行在下；hover 才显形，2.5 s 无操作淡出 |
| 播放/暂停 | 唯一允许的纯图标按钮（通用符号），中央与底栏各一个 |
| 音量、倍速、画质 | 底栏右侧，三级文字样式 + 下拉；不带彩色 |
| 返回 | 左上角三级按钮，与 SourceReaderView 的 `←` 保持一致 |
| 线路切换 | 详情页做，播放页只做只读显示（避免播放中切源的状态不一致） |
| 播完自动下一集 | 默认开，可在设置关（设置项放 `localStorage`，不进 library.json） |
| 进度记忆 | 按 `(sourceId, episodeUrl)` 存，复用 `sources` 的 progress 文件思路，**另开一个 anime progress 文件**，避免污染书本进度 |

### 4.3 键盘

- `Space` 播放/暂停，`←/→` ±5 s，`↑/↓` 音量，`F` 全屏，`Esc` 退出全屏/返回
- 与 `App.vue` 现有的 `Esc` 处理要**互斥**：播放页的 Esc 先被播放器吃掉
  （`event.preventDefault()`），否则会直接跳回列表

### 4.4 关于「WebView 嗅探取流」

Kazumi 靠 `flutter_inappwebview` 拦截网络请求拿到 m3u8。Tauri 2 侧没有等价的原生 API，
需要 WebView2 的 CDP（`Network.requestWillBeSent`）或 `WebResourceRequested` 事件。
这**不做进 MVP**：

- `direct` + `page` + `regex` + `api` 四种策略已经能覆盖相当一部分站；
- CDP 方案在 Linux（WebKitGTK）上没有对应实现，会变成只有 Windows 能用的功能，
  而 litearti 的设计前提是「外壳与平台无关」。

如果实际试下来覆盖率不够，再单独立阶段。

---

## 五、两个项目的规则对照与转换（你要求的文档）

会单独写成 `docs/kazumi-rule-conversion.md`，这里先给结论表。

### 5.1 Kazumi Plugin → litearti 源

| Kazumi 字段 | litearti 落点 | 说明 |
|---|---|---|
| `name` | `name` | 直接对应 |
| `version` | `version` | 直接对应 |
| `type` | `type: 'video'` | Kazumi 只有 `anime`，固定映射 |
| `baseURL` | `homepage` | 同时作为相对地址解析基准 |
| `searchURL` | `search.url` | `@keyword` → `{{keyword}}`；`@page` → `{{page}}` |
| `usePost` + `searchURL` 的 query | `search.method='POST'` + `search.body` | Kazumi 把参数放在 URL query 里再当表单发；litearti 用 `body` 模板表达 |
| `searchList` | `search.list` | 加 `xpath:` 前缀 |
| `searchName` | `search.fields.title` | |
| `searchResult` | `search.fields.detailUrl` | 补 `/::attr(href)`（Kazumi 取的就是 href） |
| `chapterRoads` | `video.roads` | |
| `chapterResult` | `video.episodes` | |
| `referer` | `request.headers['Referer']` | |
| `userAgent` | `request.headers['User-Agent']` | 空值时用校验器默认 UA |
| `useWebview` / `useNativePlayer` / `useLegacyParser` | **无对应** | litearti 只有一种播放实现，转换时丢弃并记一条 info |
| `adBlocker` | **无对应（本期）** | m3u8 去广告在 Kazumi 是独立过滤器；本期不做 |
| `searchMode/chapterMode = 'api'` + `searchApiConfig` | `search.url/method/body` + `$.` 选择器 | JSONPath 子集够用 |
| `antiCrawlerConfig` | **无对应** | 需要 WebView 验证码流程，本期不做；转换时明确报「该源依赖反爬验证，可能不可用」 |

### 5.2 三个转不过去的语义（必须写进文档，别让用户以为是 bug）

1. **多线路 → 剧集索引会错位。** Kazumi 的 `Road` 是「线路 → 剧集数组」，litearti 沿用同样的结构，
   但 Kazumi 的 `identifier` 允许空数组，litearti 会用「第 N 集」补齐。
2. **取流方式不同。** Kazumi 允许「内置播放器失败就退回 WebView 播页面」；litearti 没有这条退路，
   只能报错。转换后的源如果播放失败，大概率是缺 `playback` 配置而不是规则写错。
3. **XPath 支持不完整。** Kazumi 自己就只支持 `//` 开头的选择器。litearti 用浏览器原生 XPath，
   理论上更全，但**不要假设 Kazumi 能跑的规则在两边行为一致**——谓词、位置函数（`last()`）都可能不同。

### 5.3 litearti 源 → Kazumi（反向，供参考）

`type: video` 的源可以导回 Kazumi 的 `Plugin` 形状：`search.fields.*` → `searchName/searchResult`，
`video.roads/episodes` → `chapterRoads/chapterResult`。`playback` 块**无法反向表达**
（Kazumi 不描述取流方式，它靠嗅探），需要人工处理。

### 5.4 转换器

`scripts/convert-kazumi-plugin.mjs`：

```bash
node scripts/convert-kazumi-plugin.mjs rule.json               # 单个
node scripts/convert-kazumi-plugin.mjs KazumiRules/*.json -o out/  # 批量
```

行为：

- 输出前跑一遍 `validateSource`，不合法就**打印问题清单并以非零码退出**，不产生半个文件。
- 无法映射的字段汇总成 `notes` 数组，打印到 stderr，不静默丢弃。
- 支持 `--dry-run` 只打印不写盘。

---

## 六、UI 与设计系统

### 6.1 新增导航项

`ShellSection` 加 `'anime'`，侧栏变成：看板 / 资料库 / **番剧** / 书源。
折叠态（56 px rail）同样显示，靠 tooltip 补文字，与现有规则一致。

### 6.2 三个屏幕

全部沿用 `--shell-max` + `--content-pad` 的居中栏，与 `SourceBrowseView` 同构：

**AnimeBrowseView** — 与书源浏览页几乎一样：顶部返回 + 源切换 + 搜索框，
下面是网格。区别只有卡片内容（封面比例 16:9 而非竖版）。

**AnimeDetailView** — 左封面右信息（与 `SourceDetailView` 的 hero 一致），
下方是**线路标签行 + 剧集网格**。这是唯一需要新设计的组件：

```
┌ 线路 ┬──────────────────────────────────────┐
│ 线路1 │ 01  02  03  04  05  06  …           │
│ 线路2 │ 剧集用小方块，已看过的用 --ink-tertiary  │
│ 线路3 │ 当前集的用 --surface-ink 反白（不引入色）│
└──────┴──────────────────────────────────────┘
```

**AnimePlayerView** — 全窗口，无侧栏（与阅读页同一逻辑：播放是专注模式）。

### 6.3 视觉上向 Kazumi 借什么、不借什么

| 借 | 不借 | 原因 |
|---|---|---|
| 线路 / 剧集的网格排布 | 彩色 pill 标签 | 违反「不用色相建立层次」 |
| 播放器控制条的信息顺序 | 大圆角霓虹按钮 | 与 `--radius-*` 阶梯冲突 |
| 封面上叠的渐变压暗（保证标题可读） | 卡片阴影浮起 | 设计系统里卡片不带阴影，靠色差 |
| 「已看」用弱化而非勾选 | 品牌主色 | 第一条规则就是没有品牌色 |

一句话：**布局学 Kazumi，皮肤还是 litearti。**

---

## 七、分阶段计划

每个阶段都要求「可验证、可回退」，不做跨阶段的大爆炸式合并。

### P0 · 技术验证（1 个 spike，约 1 天）

**只验证一件事**：hls.js 能不能通过 `kazumi-stream://` 代理把真实 m3u8 播出来。

- 在 Rust 里写最小可用的 scheme handler：不做 m3u8 重写，只代一个固定 m3u8 与它的分片。
- 前端一个临时页面，`<video>` + hls.js 播它。
- 用**带 Referer 校验**的真实源验证（需要你提供一个可用的测试地址，见 §7 问题 2）。

**判定**：能播 → 继续 P1；不能播 → 停下来重新选底座（外部播放器 / libmpv），
不要在错误的地基上盖三层楼。

### P1 · 规则层（约 2–3 天）

- `xpath:` 前缀 + 求值 + 属性函数
- `video` 块的类型与校验
- `videoDetail()` / `episodeVideoUrl()`
- `scripts/verify-video-schema.mjs`、`verify-m3u8-rewrite.mjs` 雏形
- 用一个真实源的 HTML 快照做离线测试（存成 fixture，不联网）

### P2 · 流代理（约 2–3 天）

- `stream.rs`：m3u8 重写、Range、上限、错误
- `proto.rs`：scheme 注册与 CORS
- Rust 单测：相对地址解析、master/media 两种 playlist、`EXT-X-KEY`、206
- `scripts/verify-m3u8-rewrite.mjs`

### P3 · UI（约 3–4 天）

- 三个视图 + 卡片 + 线路/剧集组件
- i18n key
- `anime` store（导航栈 + 播放进度）
- 侧栏与 `App.vue` 接线
- 键盘与 Esc 互斥

### P4 · 收尾（约 1–2 天）

- Kazumi 规则转换器 + `docs/kazumi-rule-conversion.md`
- `README.md` 与 `docs/project-overview.md` 同步（**包括「网络边界被放宽的那一处」**）
- 全量回归：`pnpm build`（含 `vue-tsc`）、`cargo test`、离线 verify 脚本
- 手工验证清单（§8）

---

## 八、验收清单

- [ ] 从侧栏进入番剧，能选源、搜索、看到带封面的结果
- [ ] 详情页能显示线路与剧集，切换线路剧集列表正确变化
- [ ] 播放能起播，能拖动进度（mp4 与 m3u8 各验一次）
- [ ] 播放进度记忆准确，退出重进能续播
- [ ] 播完自动下一集，最后一集停在播完态
- [ ] `Esc` 从播放页回到详情，而不是直接回列表
- [ ] 网络异常 / 源失效 / 选择器错误，三种错误各有可读提示，不白屏
- [ ] `pnpm build` 零 TS 错误；`cargo test` 全绿
- [ ] 所有新增文案走 i18n，无硬编码中文
- [ ] 断网时看板 / 资料库 / 本地阅读完全不受影响（回归现有承诺）
- [ ] **任意一个 Kazumi 规则转换后能跑通搜索与详情**（不要求都能播）

---

## 九、我认为需要你先拍板的几个问题

1. **hls.js 是第 6 个运行时依赖。** README 明确写了「运行时前端依赖 5 个」，
   加 hls.js 要么改这句话，要么自己实现 HLS 解析（不值得）。
   → 建议接受，并同步改 README 的措辞。
2. **测试源。** P0 需要一个真实、稳定、要求 Referer 的番剧源来验证代理。
   你手上有可用的 Kazumi 规则 / 网址吗？没有的话 P0 只能退化成「用一个公开 HLS 测试流，
   但验不到防盗链」——那样 P0 的结论会打折。
3. **番剧源放在哪。** 建议：共用同一个书源存储与「书源」管理页，靠 `type` 字段过滤；
   番剧板块只展示 `type: video` 的源。这样不产生两套存储、两套导入导出。
   若你希望番剧源在番剧板块内单独管理，需要在 P1 前确定，会影响 store 结构。
4. **Kazumi 的 `adBlocker`（m3u8 去广告）要不要做。** 它不影响 MVP 主链路，
   但很多国内源有广告分片，不做的话观感会明显差一截。建议放到 MVP 之后单独做。
