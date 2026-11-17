# 架构：层、边界、数据流

---

## 一、分层的形状

```
┌─────────────────────────────────────────────────────────┐
│  views/            页面：取数据、排布局、转交事件        │
├─────────────────────────────────────────────────────────┤
│  components/       可复用组件                            │
├─────────────────────────────────────────────────────────┤
│  stores/ (Pinia)   跨页面的状态                          │
│  library/ sources/ discover/ export/  业务逻辑（纯逻辑） │
├─────────────────────────────────────────────────────────┤
│  api/  discover/api  export/pickDirectory  sources/mirror│
│                     ★ 唯一允许接触 Tauri 的一层          │
├─────────────────────────────────────────────────────────┤
│  Rust: lib.rs 的命令 → 各业务模块                        │
├─────────────────────────────────────────────────────────┤
│  Rust: 网络模块（net / bangumi / rules_mirror / stream） │
└─────────────────────────────────────────────────────────┘
                              ↓
              文件系统 / HTTP(S) / WebView2 / mpv(无)
```

**箭头只向下。** 下层不 import 上层。

---

## 二、三条硬边界

### 2.1 网络只走 Rust

**规则**：前端不允许出现 `fetch(` 或 `XMLHttpRequest`。

**为什么**：源站点几乎全部没有 CORS 头，浏览器 `fetch` 会被拦。更根本的是——网络能力集中在 Rust 意味着只有 4 个模块需要审，而不是几十个组件。

**在哪里强制**：全局搜索 `fetch(` 应该为空。实际验证过。

**四个网络模块，各自的契约不同**：

| 模块 | 用途 | 限制 |
|---|---|---|
| `net.rs` | 源抓取 | 仅 GET/POST、仅 http(s)、10MB、头白名单、无 cookie jar |
| `stream.rs` | 播放代理 | 仅 GET、64MB/分片、重定向逐跳校验、可带源声明的 cookie |
| `bangumi.rs` | Bangumi 元数据 + 封面 | 固定镜像、1 req/s、磁盘缓存、失败回退 |
| `rules_mirror.rs` | 社区规则 | **镜像编在 Rust 里，前端只传 id**、名字校验 |

**`rules_mirror.rs` 为什么必须编死镜像**：如果接受前端传 URL，这个命令就成了通用代理——可以请求任意地址。`net.rs` 和 `proto.rs` 小心翼翼守的正是这条线。

### 2.2 Tauri 只在适配层

**规则**：视图和组件不 `import { invoke }`。

**被允许 import `@tauri-apps/*` 的只有 4 个文件**：

| 文件 | 为什么它可以 |
|---|---|
| `src/api/library.ts` | 主适配层，绝大多数命令 |
| `src/discover/api.ts` | 发现的命令 + 封面缓存 |
| `src/export/pickDirectory.ts` | 目录选择对话框 |
| `src/sources/mirror.ts` | 规则镜像命令 |

> 历史：`SourcesView.vue` 曾经自己 `import { open as openDialog }`。这是真实的泄漏，已修（新增 `api.pickSourceFile()`）。审计时如果又冒出第 5 个文件，说明边界在被侵蚀。

**为什么重要**：桌面 → 移动端迁移时，只有这一层需要第二份实现。

### 2.3 不用 UI 组件库

**规则**：所有视觉数值来自 `src/styles/tokens.css`，组件里不允许硬编码。

**为什么**：有了组件库就会有"按钮不够突出就换主题色"的捷径，而这个项目的层次完全由**间距/尺寸/对比度/字重**建立，没有品牌色。详见 `docs/design-system.md`。

---

## 三、五个注册表（加东西不改流程）

这个项目里"扩展"不靠改分支，靠注册。

| 注册表 | 位置 | 加一个要做什么 |
|---|---|---|
| 查看器 | `viewers/registry.ts` | 拿扩展名注册 descriptor，壳不动 |
| 导出目标 | `export/registry.ts` | 注册 descriptor，流水线不动 |
| 进度读取器 | `library/progress.ts` | 按扩展名注册，记忆位置不动 |
| 选择器前缀 | `sources/schema.ts` + `selector.ts` | 加前缀 + 实现 |
| 规则镜像 | `src-tauri/src/rules_mirror.rs` | 加 enum 变体 + base URL |

**判定**：如果一个功能需要"在每个格式上 if 一下"，它应该是注册表。

---

## 四、四条主要数据流

### 4.1 读本地文件

```
LibraryView 点击条目
  → App.vue open(entry)
  → ReaderView
  → viewers/registry 按 entry.extension 选查看器
  → 查看器通过 host 调用
  → api.readText / readBinary / entryUrl
  → invoke('library_read_text' / ...)
  → Rust library.rs 找到 stored_path
  → 返回字节/文本
```

**关键**：查看器拿不到路径。它只知道"条目 id"和 `host` 暴露的方法。`entryUrl()` 是唯一拿到可渲染 URL 的途径（转成 asset 协议，因为 webview 拒绝 `file://`）。

### 4.2 源搜索

```
SourceBrowseView
  → SourceEngine.search(keyword)          [src/sources/engine.ts]
     → 按 schema 拼 URL
     → api.sourceFetch({ url, sourceId, ... })
     → invoke('source_fetch')
     → Rust net.rs：校验 → HTTP → 大小截断 → 头白名单
     → 回来
  → selector.ts 按前缀解析
     ├ $. → JSONPath
     ├ css: → querySelector
     ├ xpath: → document.evaluate
     └ @js: → sandbox.ts（iframe，3 秒超时）
  → 结果 Item[]
```

### 4.3 番剧播放

```
AnimeDetailView → episodeVideoUrl(episode)
  → 按 playback.kind 取流
     ├ direct / page / regex / api  → 直接得到 URL
     └ sniff                        → invoke('sniff_media') → Rust CDP
  → stream.ts 构造 kazumi-stream:// URL
  → <video src="kazumi-stream://...">
  → 自定义 scheme handler (proto.rs)
     ├ 检查 webview label 必须是 "main"   ★ 安全边界
     └ 交给 stream.rs
  → stream.rs：解析参数 → HTTP(Range) → 返回
```

**`proto.rs` 的 label 检查不是诊断，是安全边界**：scheme 是应用级注册的，任何窗口都能访问。没有这个检查，一个加载远程页面的窗口就能把代理当 SSRF 客户端用。查证过程见 `docs/sniffing.md`。

### 4.4 发现

```
DiscoverView
  → discover/api.ts loadPopular / loadCalendar
  → invoke('bangumi_popular' / 'bangumi_calendar')
  → Rust bangumi.rs
     ├ 查磁盘缓存（热门 1h / 日历 6h）
     ├ 等 1 秒限速闸门
     └ 请求 api.kazumi.fyi（失败则用过期缓存）
  → 返回 JSON **文本**
  → discover/subject.ts parseSubject 宽容解析
  → SubjectCard
     → discover/api coverUrl
     → invoke('bangumi_cover') → 磁盘缓存 or 负缓存
     → convertFileSrc → <img>
```

**为什么解析在 TypeScript 而不是 Rust**：两个 Bangumi 端点字段不一致（`rating.count` 一个是对象一个是数组，`date` 一个有另一个没有）。解析在 TS 里写一次，用真实 fixture 测（`verify-bgm-parse.mjs`）。Rust 再写一份就是第二个会漂的地方。

---

## 五、状态在哪

**问题**：一个数据该放内存、localStorage、还是磁盘文件？

| 数据 | 位置 | 为什么 |
|---|---|---|
| 库条目、进度 | `app_data/library/library.json` | 用户的**内容**，要迁移、要备份 |
| 库文件副本 | `app_data/library/files/` | 同上 |
| 源配置 | `app_data/sources/sources.json` | 要能被导入导出 |
| 登录 cookie | `app_data/sources/credentials.json`（加密） | **绝不进前端、绝不进源文件** |
| Bangumi 元数据缓存 | `app_data/sources/bangumi-cache.json` | 可重建，跨重启有意义 |
| 封面 | `app_data/sources/bangumi-covers/` | 可重建 |
| 规则镜像缓存 | `app_data/sources/rules-mirror-cache.json` | 可重建 |
| 主题、折叠状态 | `localStorage` | 界面偏好，不是内容 |
| 资料库查询、视图模式 | `localStorage` | 同上 |
| 阅读偏好 | `localStorage` | 同上 |
| 番剧收藏状态 | `localStorage` | 是"我在意吗"的备注，不是内容 |
| 番剧播放进度 | `localStorage`（未加入库时）/ `Entry.progress`（已加入） | 见 03-decisions |

**判定标准**：如果丢了会让人痛苦 → 磁盘文件；如果丢了只是要重新设置 → localStorage；如果丢了能重建 → 缓存文件。

---

## 六、错误处理的分层

| 层 | 怎么处理 |
|---|---|
| Rust | 返回 `AppError`，**消息是给人看的中文**，不是 `io::Error` 的 Debug |
| `api/` | 不吞错，让它抛到调用方 |
| store | 捕获并写进 `error.value`，界面显示 |
| 视图 | 有 `error` / `empty` / `loading` 三态，不允许"空白即正常" |

**Rust 的错误消息不能直接 `?` 传 `io::Error`**：`error.rs` 里做了收敛，因为 `No such file or directory (os error 2)` 对一个中文用户毫无意义。

---

## 七、异步与线程

| 场景 | 做法 |
|---|---|
| Tauri 命令 | `async fn`，跑在 Tauri 的 tokio 运行时 |
| 阻塞等待（限速闸门） | `tauri::async_runtime::spawn_blocking` |
| WebView2 COM | 必须在 webview 线程；`with_webview` 闭包内**不能**等回调（死锁） |
| 流代理并发 | 全局 `Mutex` 串行（防内存放大） |
| 多源检索 | 并发 4，单源 12 秒超时 |

**`sniff/windows.rs` 里的死锁坑**：`with_webview` 的闭包跑在 webview 线程，COM 完成回调**也**由该线程的消息泵投递。在闭包里 `recv_timeout` 等回调 = 消息泵停了 = 永远等不到。所以是"发起后立刻返回"，不能等。

---

## 八、测试的分层

| 类型 | 位置 | 需要什么 |
|---|---|---|
| Rust 单元测试 | 各模块 `#[cfg(test)]` | 无需网络 |
| 纯逻辑验证 | `verify-*.mjs`（esbuild 打包后 Node 跑） | 无需应用 |
| 界面验证 | `verify-ui-*.mjs`（CDP 驱动真实应用） | **需要应用在跑** |
| 截图 | `shots-*.mjs` | 同上，只产出图片给人看 |

**关键原则**：测试要跑**应用自己的代码**，不能在测试里重写一遍逻辑。所以 `verify-*.mjs` 用 esbuild 把真实的 TS 模块打包出来跑，而不是复制一份实现。

**`sniff/windows.rs` 是例外**：它的 COM 初始化会让 `cargo test` 的二进制在加载期就崩（`0xC0000139`），所以用 `#[cfg(all(target_os="windows", not(test)))]` 排除。**这是真实缺口**：CDP 采集层没有单元测试，唯一覆盖是 `verify-sniff.mjs` 端到端脚本。
