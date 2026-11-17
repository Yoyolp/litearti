# 嗅探：设计与实现记录

> 状态：**Windows 已实现，端到端实测通过**
>
> 本文记录嗅探的决定与实现，包括几处只能靠实机踩出来的坑——重新推导一次代价很高。

---

## 零、范围（已定）

| 项 | 决定 |
|---|---|
| 平台 | **只做 Windows**。Android 暂不做——应用基本功能尚未完成，贸然上多平台只会引入不可预测的问题 |
| 技术手段 | **CDP**（`Network.requestWillBeSent`），不是纯 JS 注入 |
| B 方案（webview 直接播页面） | **不做** |
| 失败表现 | **简单的报错提示**，不静默，不重试 |
| 等待策略 | **等满超时收集全部**，不是首命中即停 |
| cookie | 给代理补，且**统一走"按 sourceId 查凭证"** |
| `blob:` / DRM | 与"没嗅到"**分开提示** |

---

## 一、平台真相（查证过，不是推测）

### 1.1 这个项目现在没有 Android

```
android/  ios/  gen/      → 均不存在
tauri.conf.json           → 无 mobile 配置
Cargo.toml                → 无 mobile 目标
```

要让 Android 能跑，前置工作是 `tauri android init`、NDK、签名、以及 `login.rs` 里那套
Windows-only 的 cookie 捕获重写。**嗅探在其中只占很小一部分**，大部分成本在"先让它跑起来"。

所以嗅探按两端抽象、只实现 Windows，与 `login.rs` 现在的形状一致。

### 1.2 Android 的能力反而更强（供将来参考）

`WebViewClient.shouldInterceptRequest` 能拦到**包括 iframe 在内**的所有请求，且不需要 CDP。
但它在 Kotlin/Java 层，要通过 Tauri plugin 桥接。等 Android 工程就位时，这是首选路径。

### 1.3 三端的拦截能力对比

| 手段 | 能看到跨域 iframe？ | 能看到响应头？ | 平台 |
|---|---|---|---|
| JS 注入（documentStart） | ❌ | ❌ | 三端 |
| **CDP Network 域** | ✅ | ✅ | 仅 Windows |
| `shouldInterceptRequest` | ✅ | ✅ | 仅 Android |

加密解析站（DM84 那种）全在 iframe 里，所以纯注入是半成品——这是选 CDP 的理由。

---

## 二、已查证并落地的安全修复（`proto.rs`）

### 2.1 问题

`register_asynchronous_uri_scheme_protocol` 是**应用级**注册，不是主窗口专属。所以：

```
嗅探窗口加载 evil-anime-site.com
  → 页面 JS 发现 kazumi-stream.localhost
  → fetch('/stream?u=<任意URL>&s=<猜的sourceId>')
  → 代理带着该源 cookie 去请求，把响应原样返回
```

这是**以应用为客户端**的 SSRF，加上 cookie 读取。而且这个洞在**没有嗅探窗口时也存在**——
只要有任何非主窗口的 webview 加载远程页面。

### 2.2 查证过程（结论不能靠猜）

`UriSchemeContext::webview_label()` 到底返回什么，逐层追了源码：

| 层 | 版本 | 事实 |
|---|---|---|
| tauri | 2.12.5 | `UriSchemeContext { webview_label: &'a str }`，由 `webview_id` 填充 |
| tauri-runtime | 2.12.2 | 回调签名 `Fn(&str, Request, Responder)`，参数名 `webview_id` |
| tauri-runtime-wry | 2.12.3 | **`webview_builder.with_id(&label)`** —— 传的是窗口 label |
| wry | 0.57.1 | `pub type WebViewId<'a> = &'a str;`，注释：*"An id that will be passed when this webview makes requests in certain callbacks"* |

链路闭合：**`webview_label()` 就是窗口 label**，不是不透明计数器。

### 2.3 运行时实测

在 `handle()` 里临时打印，发一次代理请求，然后撤掉：

```
PROTO-LABEL-PROBE: "main"
```

主窗口报告 `"main"`，与 `capabilities/default.json` 里的 `"windows": ["main"]` 一致。

### 2.4 修复

```rust
const ALLOWED_WEBVIEW: &str = "main";

if context.webview_label() != ALLOWED_WEBVIEW {
    responder.respond(plain(StatusCode::FORBIDDEN, "这个代理只服务主窗口"));
    return;
}
```

配一条测试（`only_the_main_webview_is_allowed`）固定住。

**这条约束的含义**：将来任何新窗口（嗅探、登录、预览）都**默认不能**用代理。
如果某个窗口确实需要，必须是一次有理由的显式决定，而不是顺带放开。

---

## 三、抽象：采集与判断分离

嗅探是两件事，混在一起会导致每个平台复制一遍挑选逻辑。

| 层 | 职责 | 平台相关 | 可测性 |
|---|---|---|---|
| **采集** | 开窗口、CDP 监听、吐出 URL 事件 | ✅ Windows 一套 | 差（必须真跑） |
| **判断** | 从事件流认出媒体地址、排序、决定何时收工 | ❌ 完全无关 | **好（纯函数）** |

### 3.1 判断层（现在就能写和测）

```rust
pub struct MediaSighting {
    pub url: String,
    pub source: SightingSource,    // Network | DomAttribute | PerformanceEntry
    pub initiator: Option<String>, // 谁发起的，用于排序
    pub at: Instant,
}

pub enum MediaKind { Hls, Mp4, Dash, Blob, Unknown }

pub enum PickOutcome {
    Found { url: String, kind: MediaKind, master: bool },
    /// 找到了地址，但确认播不了 —— 与"没找到"是两回事。
    Unplayable { reason: UnplayableReason },
    NotFound,
}

pub enum UnplayableReason { Blob, Drm, LicenseRequired }

pub fn pick_media(sightings: &[MediaSighting]) -> PickOutcome;
```

`pick_media` 必须处理的判断，每条都是踩过的坑：

| 情况 | 处理 |
|---|---|
| `blob:` 地址 | 页面用了 MSE，真实 m3u8 在 XHR 里。blob 本身不能播，**继续往下找**；只有找不到时才返回 `Unplayable(Blob)` |
| master vs media playlist | 两者都能播；master 更好（有清晰度选择）。识别 `#EXT-X-STREAM-INF` |
| `.ts` 分片 | **不当候选**。分片是结果不是入口 |
| 广告分片 | 也是 `.m3u8`。用 `initiator` + 时长排序，是启发式，不可靠 |
| DRM | `EXT-X-KEY` 指向 license 端点 → `Unplayable(Drm)` |

### 3.2 采集层（接口）

```rust
pub struct SniffRequest {
    pub page_url: String,
    pub session: SniffSession,   // cookie / UA 必须与登录时一致
    pub timeout: Duration,       // 等满，不提前收工
}

pub struct SniffOutcome {
    pub sightings: Vec<MediaSighting>,
    /// 本次会话的 cookie，用于回写。
    pub cookies: Vec<CookieRecord>,
}

#[async_trait]
pub trait WebviewSniffer: Send + Sync {
    async fn sniff(&self, request: SniffRequest) -> AppResult<SniffOutcome>;
}
```

`SniffOutcome` 带回 cookie 是刻意的，理由见第五节。

---

## 四、Windows 实现的三个坑

### 4.1 隐藏窗口会被节流

WebView2 在 `IsVisible = false` 时限制计时器与渲染，页面可能**根本不加载视频**。
症状是"有时候能嗅到、有时候不能"，极难查。

**已定做法**：窗口**可见但移出屏幕**（或置底）。并且 UI 上说明"正在后台打开一个窗口"，
避免用户以为程序失控。

### 4.2 嗅探窗口必须不授予任何 capability

远程页面若能拿到 `__TAURI_INTERNALS__`，就能调用全部 IPC 命令。
Tauri 2 的 capability 是按窗口 label 授权的，所以：

- 独立 label（如 `sniff-<uuid>`）
- **不加入任何 capability**
- 加上第二节的 label 校验作为第二道

### 4.3 多数站需要先点一下播放

如果剧集页是"点播放按钮才加载视频"，只打开页面什么也嗅不到。

**已定做法**：打开后等满超时，接受部分站嗅不到，给出**简单报错提示**。
不做自动点击（启发式会点错），不做可见窗口让用户手动点（超出范围）。

---

## 五、cookie：完整代价与决定

### 5.1 现状（`credentials.rs` 的三条硬约束）

```rust
if entry.host != request_host { return Ok(None); }   // 精确 host
// 子域名不继承：cdn.example.com 拿不到 example.com 的 cookie
// Set-Cookie 从不采集
```

且模块注释写明：**没有任何命令把 cookie 交给前端。**

### 5.2 决定

**统一走"传 sourceId，后端查"**，cookie 值永不进入 URL 或前端。

```rust
// proto.rs 的 URL
kazumi-stream://localhost/stream?u=<target>&s=<sourceId>&r=<referer>&ua=<agent>

// stream.rs
pub struct StreamRequest {
    pub target: String,
    pub referer: Option<String>,
    pub user_agent: Option<String>,
    pub range: Option<String>,
    /// 哪个源在请求。代理据此查凭据，**不接受 cookie 值**。
    pub source_id: Option<String>,
}
```

### 5.3 代价（六条，写下来是为了不忘记）

1. **文档承诺要改。**
   `docs/stream-proxy.md` 现在写着"不维持 cookie……登录态专属的播放地址不支持"。
   改它不是错，但必须公开改。

2. **新增攻击面：媒体 URL 的 host 由远程页面决定。**
   现在的链路是"规则 → 我们拼 URL"，规则用户可见。嗅探后变成"远程页面建议 URL"。
   精确 host 匹配仍在，但要加一条：**记录哪个 host 收到了 cookie**，出问题能查。

3. **`stream.rs` 需要拿到数据目录**（或查凭据的能力）。
   注意 handler 跑在异步运行时线程，读文件要么 `spawn_blocking`，要么接受小文件开销。

4. **每个分片都查一次凭据。**
   几百个分片 × 读文件 + 解密。需要缓存：**按 `sourceId + host` 缓存，登录成功后清空**。

5. **cookie 绝不能进 URL。**
   实现者若把 cookie 塞进 `?c=xxx`，它会进 devtools、日志、历史。
   `proto.rs` 的注释里要写死理由，不只写规则。

6. **跨 host 重定向时 cookie 必须被剥离。**
   `reqwest` 默认行为正确，但要**写测试固定住**，否则将来有人"优化"掉，session 就泄漏到第三方 CDN。

### 5.4 分两步走

**第一步（不依赖嗅探）**：只加 `sourceId` 参数。
有些 `direct/page/regex` 规则的媒体地址本身就需要 cookie，现在是 403，加上就能播。
这一步风险可控——URL 来自用户可见的规则。

**第二步（嗅探）**：复用第一步的通道，不二次改动。

---

## 六、嗅探会顺带修复的一个既有问题

站点在嗅探窗口加载时很可能**刷新会话**（下发新 `Set-Cookie`、反爬 token）。
新 cookie 在 WebView2 的 cookie jar 里，**不在 `credentials.json` 里**。于是：

```
嗅探窗口用新 cookie 拿到 URL → 代理用旧 cookie 请求 → 403
→ 错误显示"URL 失效"，把人引向错误方向
```

**已定做法（你确认的"统一"）**：嗅探成功后把窗口里的 cookie **回写**
`credentials.json`，沿用 `login.rs` 已有的 cookie 读取代码。

这条顺带解决了"站点续期后登录态失效"这个独立问题。

---

## 七、规则层表达

```jsonc
"playback": {
  "kind": "sniff",
  "expect": "hls",       // 可选：hls | mp4 | any
  "onFailure": "error"   // error | none（none 只提示，不报错）
}
```

规则自己声明"我需要嗅探"，引擎不猜。UI 在详情页就能提示"这个源会打开一个后台窗口"。

---

## 八、错误提示的分级（你定的"简单报错"）

| 情况 | 提示 |
|---|---|
| 平台不支持嗅探 | "这个平台不支持嗅探播放" |
| 嗅探超时、没找到 | "没嗅到播放地址。这个源可能需要在浏览器里看。" |
| 嗅探到 `blob:` | "这个源用了 MSE 播放，地址拿不到。" |
| 嗅探到 DRM | "这个源用了数字版权保护，无法在应用内播放。" |
| 嗅探窗口打不开 | "无法打开嗅探窗口。" |

**共同点**：都停在剧集列表，「访问网站」按钮仍然可用。不重试、不弹模态框。

---

## 九、实现记录：三处只能实机踩出来的坑

这三条都是写代码时不会发现、只有真跑起来才暴露的问题。

### 9.1 在 webview 线程上等待回调 = 死锁

第一版 `enable_network` 在 `with_webview` 闭包里用 `recv_timeout` 等
`CallDevToolsProtocolMethod` 的完成回调。症状是**每次都超时**，报"连接调试协议超时"。

原因：`with_webview` 的闭包跑在 webview 线程上，而 COM 完成回调**也**由那个线程的消息泵
投递。当前线程阻塞在 `recv_timeout` 上，消息泵停了，回调永远不来。

`login.rs` 早就避开了这一点：它在闭包里只发起异步操作、立刻返回，等待放在外面。

**修法**：`Network.enable` 改成即发即弃（completion handler 存在但不等待）。如果它真的失败，
不会有事件到达，嗅探超时返回"没找到"——诚实，只是不够具体。

### 9.2 凭据存在 `sources/` 子目录下，不是数据根

`persist_cookies` 一开始写 `app_data_dir()/credentials.json`，而
`credentials_status`、`net.rs`、`login.rs` 全都读 `sources_root()` ——
即 `app_data_dir()/sources/credentials.json`。

**后果**：写成功了，但没有任何读者能找到它。测试表现为"后端日志说 persisted，查询却是 null"。

**修法**：`sniff/commands.rs` 和 `proto.rs` 都改成
`app_data_dir().map(|dir| sources::sources_root(&dir))`。这条同时也修好了流代理查 cookie 的路径。

### 9.3 COM 代码无法进测试二进制

把 `sniff::windows` 编译进 `cargo test` 的二进制会让**进程在加载期就退出**，
`STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)`，一个测试都跑不了——连 `--list` 都崩。

定位过程值得记：`git stash` 对比、逐步移除模块、检查导入表，最后确认是 COM 初始化与测试
harness 的冲突（`libtest` 不带消息泵）。

**修法**：`#[cfg(all(target_os = "windows", not(test)))]`。
生产构建含完整采集层，测试构建只含可测的判断层与解析逻辑。

**这是一个真实缺口，不是优雅的解法**：CDP 采集层现在**没有任何单元测试**。
它唯一的自动化覆盖是 `scripts/verify-sniff.mjs`——一个起本地 fixture 服务器、
真的开嗅探窗口、真的走 IPC 的端到端脚本。如果那个脚本坏了，采集层就是无测试状态。

---

## 十、实测结果（`scripts/verify-sniff.mjs`，11 项全通过）

fixture 站故意**先**发一个 `.mp4`（诱饵）**再**发 `.m3u8`（目标），验证判断层不会被首命中骗到。

| 检查项 | 结果 |
|---|---|
| Windows 上报告支持嗅探 | ok |
| `sniff_media` 返回 | ok |
| 结果是 `found` | ok |
| **挑中的是 m3u8，不是 mp4 诱饵** | ok |
| URL 指向 fixture 服务器 | ok |
| 会话 cookie 被写回磁盘 | ok |
| 写回的凭证报告含 cookie | ok |
| 不可达页面给出答案而非卡死 | ok |
| 不可达页面报 `notFound` 而非假的 `found` | ok |
| 主窗口仍能用流代理（未被 label 校验误伤） | ok |

另有 `cargo test` 140 项、`vue-tsc` 干净、13 个离线脚本 + 7 个需应用的脚本全通过。

---

## 十一、还没解决的

- **并发**：连点两集怎么办？倾向**单窗口 + 串行**，第二次取消第一次。
- **僵尸窗口**：`sniff()` 返回 `Err` 时如果没显式 `close()`，会留一个看不见的 webview。当前代码在成功和失败路径都调了 `close()`，但没有测试守着这一点。
- **取消**：用户切页面 / 退出应用时要能中止嗅探。目前只能等满超时。
- **`s` 参数可伪造**：查凭据时是否同时校验 host 来自该源的 `homepage`？多一道，但会让"源改了域名"失效。
- **`pick_media` 的 `playlist_bodies` 参数目前总是空**：DRM 检测需要抓播放列表正文，而采集层不抓（那是代理的活）。所以 DRM 只在"拿到了正文"时才判得出来，实际路径上暂时不会命中。要在播放失败后再抓一次正文才能补上。
- **`SightingSource::PerformanceEntry` 与 `DomAttribute` 只有测试在用**：CDP 只产生 `Network`。
