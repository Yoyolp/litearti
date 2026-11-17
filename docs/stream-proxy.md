# 视频播放与流代理

> 状态：已实现并实测通过（2026-11-16）
>
> 这份文档讲清楚三件事：为什么需要代理、代理放宽了哪条网络约束、以及为什么
> 一部分源注定只能解析不能播放。

---

## 一、为什么不直接用 `<video src="https://…">`

三个障碍，每一个都足以让播放失败：

| 障碍 | 后果 |
|---|---|
| **CORS** | 源站的媒体没有 `Access-Control-Allow-Origin`，hls.js 的 XHR 直接被浏览器拦下 |
| **防盗链** | 需要特定的 `Referer` / `User-Agent`，而 `<video>` 改不了请求头 |
| **HLS** | Chromium（也就是 WebView2、WebKitGTK）没有 HLS 解复用器，`.m3u8` 播不了 |

代理一次解决三个：请求从 Rust 发出（没有 CORS）、头由代理按源配置加（防盗链）、
playlist 被重写成回流的地址（HLS 由 hls.js 处理）。

---

## 二、URL 形状

```text
kazumi-stream://localhost/stream?u=<percent-encoded target>&r=<referer>&ua=<agent>
```

| 参数 | 含义 |
|---|---|
| `u` | 目标媒体地址（必填） |
| `r` | 要发送的 Referer，源配置里有才带 |
| `ua` | 要发送的 User-Agent，源配置里有才带 |

**为什么头信息放在 URL 里而不是后端会话**：播放是纯函数式的。一个 URL 自带全部上下文，
所以两集不同剧集、两个不同源不会串味；冷启动重放同一请求也能工作。代价是 URL 变长，
没有地方在乎。

**平台差异**（实测，不是推测）：

| 平台 | 实际可达的地址 |
|---|---|
| Windows / Android | `http://kazumi-stream.localhost/stream?…` |
| macOS / Linux | `kazumi-stream://localhost/stream?…` |

用错形式会在 `fetch` 阶段就报 `TypeError: Failed to fetch`，根本到不了 handler。
`src/sources/stream.ts` 按平台选形式，`scripts/verify-stream-proxy.mjs` 两种都试一遍
再选能通的那个——这个区别值得实测，因为猜错的表现和「代理没实现」一模一样。

---

## 三、网络边界：放宽了什么，没放宽什么

README 原本写着「网络只走 Rust、仅 GET/POST、仅 http(s)、10 MB 上限、不维持 cookie」。
**现在多了一条通道**，必须说清楚。

### 3.1 放宽的部分

| 项 | `net.rs`（文本） | `stream.rs`（媒体） |
|---|---|---|
| 单响应上限 | 10 MB | **分片 64 MB** / playlist 2 MB |
| 用途 | 抓书页 | 转发媒体字节 |

体积上限是唯一被放宽的东西。理由很直接：一个视频分片天然超过 10 MB，用书页的上限去卡
视频等于功能不存在。两个上限分开而不是统一提高，是为了不让「playlist」这个文本文件
消耗分片的额度——否则一个恶意源可以用 64 MB 的「playlist」做别的事。

### 3.2 一条都没松的部分

- **只有 GET**。播放永远不需要写别人的服务器。
- **只有 http/https**，**重定向每一跳重新校验**。这是请求逃逸到 `file://` 的唯一途径。
- ~~**不维持 cookie**~~ **已修改，见下一节。**
- **转发的头只有两个**：`user-agent`、`referer`。媒体请求不需要更多，给更多只是扩大面。

### 3.2.1 cookie：从"完全不发"改成"按源声明查"

原来的规则是"这个通道里没有会话状态"，代价是登录态专属的播放地址一律 403。

现在改成：URL 里带一个 `s=<sourceId>` 参数，代理用它去凭据库查该源的 cookie，
**只在目标 host 与该凭证的 host 精确匹配时**附加。

三条约束保证了这不会变宽太多：

| 约束 | 说明 |
|---|---|
| **只传 id，绝不传 cookie 值** | cookie 一旦进 URL 就会到 devtools、日志、浏览历史里。查库发生在后端。 |
| **精确 host 匹配** | 子域名不继承。`cdn.example.com` 拿不到 `example.com` 的凭证。 |
| **跨 host 重定向时被剥离** | `reqwest` 的默认行为就是如此，且有测试固定住——否则 session 会泄漏到第三方 CDN。 |

**为什么改**：嗅探出来的地址常常是登录态专属的。如果嗅探窗口带着 cookie 拿到 URL，
而代理用另一份（或没有）cookie 去请求，结果还是 403——**而错误看起来像"URL 失效"**，
会把人引向完全错误的方向。

**顺带修的一个路径 bug**：凭据存在 `sources_root()`（即 `app_data_dir()/sources/`）下，
而第一版实现写到了 `app_data_dir()` 根。写成功了但没人能找到，症状是"日志说写好了，
查询却是 null"。现在 `proto.rs` 和 `sniff/commands.rs` 都用 `sources_root()`。

### 3.3 为什么用自定义 scheme 而不是 IPC 命令

一个 HLS 流是几百个请求。走 `invoke` 意味着每个分片都过一遍序列化，而且 `<video src>`
根本没法调 IPC。scheme 给播放器一个「像 URL 的东西」，这正是它需要的。

---

## 四、m3u8 重写

### 4.1 最容易错的点

playlist 里绝对地址和相对地址混着写。相对地址是相对于 **playlist 自己的 URL**，不是
相对于应用。所以必须先按 `playlist_url` 解析成绝对地址，再编码。否则 `hls/seg.ts`
会变成「应用目录旁边的文件」。

### 4.2 覆盖的 URI 位置

| 位置 | 出现在 |
|---|---|
| 裸行 | 分片；master playlist 里的子 playlist |
| `#EXT-X-KEY:URI="…"` | 加密密钥 |
| `#EXT-X-MAP:URI="…"` | 初始化分片 |
| `#EXT-X-MEDIA:URI="…"` | 备用音轨 / 字幕 |
| `#EXT-X-I-FRAME-STREAM-INF:URI="…"` | 快速预览流 |
| `#EXT-X-SESSION-KEY` / `#EXT-X-PART` / `#EXT-X-PRELOAD-HINT` | 会话密钥 / 分块 / 预加载提示 |

漏掉任何一个的表现都是「流播到一半停住」或「有画面没声音」，而错误信息不会指向重写。
这些都在 `stream.rs` 的单测里逐条固定。

### 4.3 playlist 的三种识别方式

内容类型、扩展名、以及首行 `#EXTM3U`。三个都要，因为：

- 内容类型有时是 `application/octet-stream`；
- 扩展名有时没有（CDN 路径带查询串）；
- 一个不是 playlist 的 URL 内容也可能以 `#EXTM3U` 开头。

### 4.4 Range 与 CORS 的两个坑（实测踩到的）

**坑一：`Content-Range` 读不到。** 跨域响应只有被 `Access-Control-Expose-Headers` 列出的头
才能被 JS 读取。206 返回了正确字节，但播放器拿不到 `Content-Range` 就不知道这段从哪开始，
拖进度条因此不可靠。已在响应里加上 `Content-Range, Content-Length, Content-Type, Accept-Ranges`。

**坑二：`Access-Control-Allow-Origin` 本身永远读不到。** 它是协议头，不是响应数据，
`fetch` 里 `headers.get('access-control-allow-origin')` 返回 `null` 是正常的。判断 CORS 是否
生效不能看这个头，要看**跨域请求本身是否成功**。

---

## 五、播放器

### 5.1 hls.js 还是原生

```ts
video.canPlayType('application/vnd.apple.mpegurl') === 'probably'
```

**只有 `'probably'` 才算能原生播。** 这一点是实测出来的：

`canPlayType` 返回的是「也许」，WebView2 对 `application/vnd.apple.mpegurl` 回答 `'maybe'`，
但 Chromium 根本没有 HLS 解复用器——元素随后以 `MEDIA_ERR_SRC_NOT_SUPPORTED`（错误码 4）
失败，表现为黑屏加一句没用的错误。

Safari 与 iOS WebView 回答 `'probably'`；Chromium 回答 `'maybe'`，而 Chromium 有 MediaSource，
hls.js 才是正确路径。**第一版代码用了 `!== ''`，于是 WebView2 上走了原生分支，播放不了。**
`scripts/verify-stream-playback.mjs` 现在直接驱动应用自己的播放器，就是为了让这类错误无法
藏在「测试里另写一份实现」后面。

### 5.2 交互

| 操作 | 键 |
|---|---|
| 播放 / 暂停 | `Space` |
| ±5 秒 | `←` `→` |
| 音量 | `↑` `↓` |
| 全屏 | `F` |
| 退出播放 / 全屏 | `Esc` |

进度条用原生 `<input type="range">`：键盘、触屏、读屏软件的支持都是白送的，
自己画一个 canvas 进度条只会少这些。

### 5.3 进度记忆

存在 `localStorage` 的 `litearti.anime-progress`，键是 `sourceId::episodeUrl`。

**不进 `source-progress.json`**：章节进度是页面内的滚动比例，剧集进度是媒体文件里的时间戳。
两者形似而实不同，混在一起意味着一个不透明的联合类型，以及两种形状任一变化时的迁移。

---

## 六、为什么大量源「只能解析，不能播放」

实测 Kazumi 社区的 18 条规则，**`useWebview` 全部为 true**：

| 能力 | 规则数 |
|---|---|
| 能纯 HTTP 解析出剧集 | 少数几条（MXdm、DM84、AGE…） |
| 能纯 HTTP 拿到**可播放直链** | **1 条**（MXdm） |

其余的都把播放地址交给第三方解析站（加密参数）或依赖 WebView 嗅探。

所以设计上做了明确处理，而不是让用户点播放才发现：

- `videoDetail()` 成功后，**额外探测一次第一集**能否取到媒体地址；
- 探测失败时，详情页显示「这个源可能无法播放 / 需要浏览器嗅探」，**剧集列表照常可用**；
- 「访问网站」按钮始终在那里，用户可以去浏览器看。

探测是一次网络请求，不阻塞渲染：剧集列表先出来，警告随后出现。

---

## 七、验证

| 脚本 | 覆盖 | 需要网络 |
|---|---|---|
| `verify-stream-proxy.mjs` | 真实 m3u8 全链路：master → media → 分片 → Range → CORS → 错误 → `file:` 拦截 | ✅ |
| `verify-stream-playback.mjs` | 驱动应用自己的播放器：起播、解码、拖进度、进度记忆 | ✅ |
| `cargo test` 中的 `stream::tests` | m3u8 重写（相对/绝对/子列表/KEY/MAP/MEDIA）、编码往返、错误处理 | ❌ |
| `cargo test` 中的 `proto::tests` | URL 解析、Range 透传、未知参数、Windows 形式 | ❌ |

两个 UI 脚本需要**真实网络**，这是刻意的：m3u8 重写的真实形态太多，用 fixture 假装
只会测到自己想象过的那些。

实测结果（2026-11-16）：

```
master.m3u8   97 B   → 重写后 200，子列表指向代理
media.m3u8    19,853 B → 重写后 4000+ 分片全部指向代理
分片          188,000 B，首字节 0x47（TS 同步字节）
Range         206，bytes 0-1023/188000，恰好 1024 字节
播放          1080x608，1454 秒，播放到 1.7s+
拖进度        目标 60.0s，落在 60.0s
```
