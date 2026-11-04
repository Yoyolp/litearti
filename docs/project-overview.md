# litearti 项目说明

一个安静的桌面阅读器：读 TXT、看 PDF、读 EPUB、听音频，另有书源板块可联网找书。

本文档是项目的**完整介绍**——它是什么、为什么这样建、每个决定背后的取舍。如果你只想跑起来，看根目录的 `README.md`；如果你想加一种新格式，看 [`viewer-contract.md`](viewer-contract.md)；如果你想改界面，看 [`design-system.md`](design-system.md)。

分功能的深入说明另见：

| 文档 | 内容 |
|---|---|
| [`epub-viewer.md`](epub-viewer.md) | EPUB 查看器 |
| [`export.md`](export.md) | 导出与格式降级 |
| [`book-sources.md`](book-sources.md) | 书源（唯一联网的功能） |
| [`txt-chapters.md`](txt-chapters.md) | TXT 自动分章 |

---

## 目录

- [一、这个项目是什么](#一这个项目是什么)
- [二、技术选型与理由](#二技术选型与理由)
- [三、架构](#三架构)
- [四、数据与存储](#四数据与存储)
- [五、四种内置查看器](#五四种内置查看器)
- [六、设计系统的落地](#六设计系统的落地)
- [七、可扩展性：加一种新格式](#七可扩展性三个注册表)
- [八、面向安卓的移植设计](#八面向安卓的移植设计)
- [九、构建与运行](#九构建与运行)
- [十、已知限制与后续方向](#十已知限制与后续方向)
- [十一、书源](#十一书源)
- [十二、导出](#十二导出)

---

## 一、这个项目是什么

litearti 是一个本地文件阅读器。**阅读不联网**：你把文件导入进来，它记住你读到哪儿，下次接着读；打开、渲染、进度记忆全程离线，不同步、不收集数据。

**它解决的问题**：在桌面上读一份 TXT 或 PDF，通常要么用重量级 IDE / 编辑器（功能过剩、启动慢），要么用浏览器（每次都要重新找文件、重新滚动到上次位置）。litearti 只做三件事：把文件收进一个地方、用合适的渲染方式打开、记住位置。

**它明确不解决的问题**：笔记、标注、书签、云同步、批量管理。这些都在"没做"清单里（见 [第十节](#十已知限制与后续方向)）。

> **修订（2026-10）①**：原文此处写着「不联网」。书源功能上线后，这条改为**「阅读不联网」**——书源板块会联网，且只访问用户添加的书源所指向的网站，不上传任何本地数据。看板、资料库、本地阅读仍然完全离线。详见 [`book-sources.md`](book-sources.md)。
>
> **修订（2026-10）②**：原文此处还列了「格式转换」。导出功能上线后这条不再成立——可以把书**导出为纯文本**（PDF / EPUB / 文本系 → `.txt`）。但边界要说清：这是**单向、有损**的降级导出，不是格式互转。TXT 不会变成 PDF，PDF 不会变成 EPUB。详见 [`export.md`](export.md)。

### 支持的格式

| 类型 | 扩展名 | 渲染方式 |
|---|---|---|
| 纯文本 | `.txt` `.md` `.log` `.text` `.csv` `.json` `.yml` `.yaml` | 编码探测 + 段落排版（**自动分章**） |
| PDF | `.pdf` | pdf.js 渲染到 canvas |
| EPUB | `.epub` | 零依赖 ZIP 解压 + 沙箱 iframe（原版 / 重排） |
| 音频 | `.mp3` `.m4a` `.aac` `.flac` `.wav` `.ogg` `.opus` `.weba` | `<audio>` 元素 |

导入对话框只列出常用扩展名，但**这是过滤器，不是能力边界**。任何文件都能导入；能不能打开取决于有没有查看器认领它的扩展名（见 [第七节](#七可扩展性三个注册表)）。

---

## 二、技术选型与理由

### 2.1 Tauri 2 而不是 Electron

| | Tauri 2 | Electron |
|---|---|---|
| 安装包 | 本项目实测 **7.6 MB**（release exe，含 EPUB 与书源引擎） | 80 MB+ |
| 内存 | 共享系统 WebView | 每窗口一个 Chromium |
| 安卓支持 | 官方（v2 起） | 无 |
| 系统能力 | Rust，按需调用 | Node.js 全量 |

决定性因素是**安卓**。Tauri 2 的 mobile 支持是一条真实存在的路径，Electron 没有。体积和内存是附带收益。

> 体积从最初的 5.76 MB 涨到 7.6 MB，来自两处：`reqwest` + `rustls`（书源的 HTTP 客户端，约 1.2 MB），以及 EPUB 与书源的前端代码。前者换掉了系统 OpenSSL 依赖，仍保持单文件分发。

Rust 在这里的职责被刻意压到最小：读写文件、探测编码、存元数据。**它不参与渲染，也不认识任何文件格式**（见 [3.2](#32-格式归属由前端注册表决定)）。

### 2.2 不用 UI 组件库

没有 Element Plus、没有 Naive UI、没有 Tailwind。

原因不是"想炫技"，而是**组件库和设计目标冲突**：

- 组件库自带一整套视觉决策——默认圆角、默认阴影、默认蓝色主色
- 设计目标是"用间距、尺寸、对比度建立层次，不用颜色"
- 结果是每次都要用 CSS 覆盖库的默认值，最后变成"跟库打架"

自己写基础样式反而更快：`tokens.css` 定义了全部数值，`base.css` 只定义了按钮三级层次和元素默认值，加起来不到 200 行。

### 2.3 pdf.js 而不是原生 PDF 引擎

**收益**：跨平台完全一致、零原生依赖、安卓移植成本为零。

**代价**：超大或矢量密集的 PDF 比原生引擎（pdfium / mupdf）慢。

这是一次有意识的取舍。原生引擎需要在每个目标平台编译原生库，会直接破坏"安卓移植便宜"这个核心目标。如果将来性能真的成为瓶颈，替换点是 `ViewerHost` 那一层抽象——界面代码不用动。

### 2.4 依赖清单

**前端**

| 包 | 版本 | 用途 |
|---|---|---|
| `vue` | 3.5 | 框架 |
| `pinia` | 4.1 | 状态管理（4 个 store：library / export / sources / theme） |
| `@tauri-apps/api` | 2.12 | IPC、asset 协议 |
| `@tauri-apps/plugin-dialog` | 2.8 | 文件选择对话框 |
| `pdfjs-dist` | 6.4 | PDF 渲染与文本抽取 |

> 没有 ZIP 库：EPUB 的解压用浏览器原生 `DecompressionStream`，见 [`epub-viewer.md`](epub-viewer.md)。
> 没有 JSON Schema 库：书源校验器手写，为了给出指向具体字段的中文错误，见 [`book-sources.md`](book-sources.md)。

**构建**

| 包 | 版本 |
|---|---|
| `vite` | 7.3 |
| `@vitejs/plugin-vue` | 6.0 |
| `typescript` | 5.9 |
| `vue-tsc` | 3.3 |
| `@tauri-apps/cli` | 2.12 |

**Rust**

| crate | 用途 |
|---|---|
| `tauri` 2 | 应用框架（启用 `protocol-asset`） |
| `tauri-plugin-dialog` 2 | 原生文件对话框 |
| `serde` / `serde_json` | 元数据序列化 |
| `uuid` 1 | 条目 ID |
| `encoding_rs` 0.8 | 编码探测与解码 |
| `reqwest` 0.13 | 书源的 HTTP 客户端（`rustls`，不依赖系统 OpenSSL） |
| `tokio` 1 | 仅 dev-dependency，供异步测试用 |

---

## 三、架构

### 3.1 全景

```
┌──────────────────────────────────────────────────────────────┐
│  Vue 3 (WebView)                                             │
│                                                              │
│  App.vue ──┬── AppSidebar.vue      侧栏（可折叠）              │
│            │                                                  │
│            ├─ 看板   DashboardView                             │
│            ├─ 资料库 LibraryView  ── ReaderView ──┐            │
│            │                        ├ TextReader   │           │
│            │                        ├ PdfReader    │ 4 个查看器 │
│            │                        ├ AudioPlayer  │           │
│            │                        └ EpubReader   │           │
│            │                                      │           │
│            └─ 书源   SourcesView → SourceBrowseView            │
│                              → SourceDetailView               │
│                              → SourceReaderView                │
│                                                              │
│  stores/  library · export · sources · theme                 │
│  utils/   dashboard（纯函数）· format                         │
│                          │                                    │
│          ┌───────────────┼────────────────┐                  │
│          ▼               ▼                ▼                  │
│   viewers/registry  export/registry  sources/schema          │
│   （扩展名→查看器）  （目标格式→转换器）（JSON→校验）            │
│          │               │                │                  │
│          └───────────────┴────────────────┘                  │
│                          │                                    │
│                  api/library.ts   唯一的 IPC 出口（21 个函数）  │
└──────────────────────────┬───────────────────────────────────┘
                           │ invoke()
┌──────────────────────────▼───────────────────────────────────┐
│  Rust (Tauri)   17 个 command                                  │
│  lib.rs        托管状态 + 命令入口                              │
│  library.rs    托管式资料库（Mutex 保护）                       │
│  text.rs       编码探测 + 截断边界                              │
│  export.rs     导出写盘（消毒/重名/原子写）                      │
│  sources.rs    书源存储                                        │
│  net.rs        书源 HTTP（协议白名单/超时/体积上限）              │
│  download.rs   下载导入                                        │
│  external.rs   系统浏览器打开 URL                               │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
   %APPDATA%/app.litearti.reader/
     ├── library/  ← 本地书：library.json + files/
     └── sources/  ← 书源：sources.json + progress.json
```

**两条完全分开的数据线**：本地书在 `library/`，书源与书源进度在 `sources/`。删掉书源不影响已导入的书，导入的书也不依赖任何书源。

### 3.2 三个注册表，同一种模式

项目里有三处"加东西不改外壳"的扩展点，写法刻意保持一致：

| 注册表 | 加什么 | 怎么加 |
|---|---|---|
| `viewers/registry.ts` | 一种文件格式 | `registerViewer({ id, extensions, component })` |
| `export/registry.ts` | 一种导出目标 | `registerConvertTarget({ id, supports, convert })` |
| `sources/schema.ts` + `selector.ts` | 一种选择器语法 | 加前缀分支（前缀是封闭集合） |

三者的共同点：外壳只问"这个归谁"，从不认识具体格式。

### 3.2 格式归属由前端注册表决定

**这是整个架构最重要的一条。**

Rust 侧只知道一个字符串：`extension`。它不知道什么是 PDF，不知道 `.txt` 该用什么渲染，也不维护任何格式表。

```
Rust: Entry { extension: "pdf", ... }     ← 仅此而已
          ↓
前端: viewersFor("pdf") → [pdf 查看器]     ← 全部决策在这里
```

**为什么这样设计**：

1. **加格式不改外壳**。新增一种格式只需调用 `registerViewer()`，`App.vue`、`LibraryView.vue`、`ReaderView.vue` 一行都不用动。
2. **安卓移植时不用动 Rust**。格式逻辑是纯前端的，跨平台天然一致。
3. **用户可以覆盖内置行为**。`priority` 字段让自定义查看器能抢走某个扩展名，不需要改内置代码。

代价是 Rust 无法在导入时校验格式合法性。这是可以接受的——导入一个打不开的文件不是灾难，它会显示"没有查看器"的空状态并解释原因。

### 3.3 IPC 边界

所有 Tauri 调用收敛在 `src/api/library.ts` 一个文件里（21 个函数）。其他模块（store、查看器、组件）**从不直接 import Tauri**——包括原生拖拽订阅和书源 HTTP，都封装成函数放在这个文件里。

这个单点收敛是安卓移植成本低的根本原因：换平台只需要改这一个文件。

```ts
// src/api/library.ts 的完整能力面

// 资料库
listEntries()     importPaths()      removeEntry()
setProgress()     touchEntry()       readBinary()
readText()        entryPath()        entryUrl()
pickFiles()       onFileDrop()       isDesktopRuntime()

// 导出
exportWrite()

// 书源
sourceFetch()          sourcesLoad()          sourcesSave()
sourceProgressLoad()   sourceProgressSave()   sourceDownloadImport()
readPickedTextFile()   openExternal()
```

> `readPickedTextFile` 与 `openExternal` 存在的原因是不引入 `plugin-fs` / `plugin-opener` 两个额外依赖，各用一个窄命令覆盖。前者只读用户在选择器里点中的文件，后者只接受 http(s)。

### 3.4 状态管理

4 个 Pinia store，各自边界清晰：

| store | 管什么 |
|---|---|
| `library.ts` | 条目列表、导入状态、最近失败 |
| `export.ts` | 选择模式、目标格式、导出结果 |
| `sources.ts` | 书源列表、书源阅读进度 |
| `theme.ts` | 浅色 / 深色 / 跟随系统 |

**没有为"正在读哪个文件"建 store**。它是 `App.vue` 里的一个 `ref`，纯粹的界面状态，不需要跨组件共享。阅读进度存在后端（`library.json` 或 `sources/progress.json`），不走前端状态。

`export.ts` 单独存在而不是塞进 `library.ts`，是因为选择模式是一次性的交互态；混进去会让每个读 library store 的地方都得关心它。

---

## 四、数据与存储

### 4.1 托管式资料库

**导入 = 复制**。文件被复制进应用数据目录，原文件之后移动、重命名、删除都不影响资料库。

```
%APPDATA%/app.litearti.reader/
├── library/                        ← 本地书
│   ├── library.json                元数据
│   ├── library.json.tmp            写入中间态（原子替换用）
│   └── files/
│       ├── <uuid>.txt              副本，用 UUID 命名
│       ├── <uuid>.pdf
│       └── <uuid>.wav
└── sources/                        ← 书源（与本地书完全分开）
    ├── sources.json                书源定义
    └── progress.json               书源阅读进度
```

**书源为什么不进 `library.json`**：书源是配置，不是资料库内容。混进去会让每次 `library.json` 的版本迁移都要处理外来数据，而且删一个书源就可能碰到用户导入的文件。

**为什么用 UUID 命名**：避免同名冲突、避免原文件名里的特殊字符影响路径、避免用户误以为可以直接改这个文件。

**为什么是复制而不是引用**：

| | 复制（本项目） | 引用 |
|---|---|---|
| 源文件移动/删除 | 不受影响 | 条目失效 |
| 磁盘占用 | 双份 | 单份 |
| 导入大文件 | 需要时间 | 瞬时 |

选复制是因为**"库"这个心智模型要求条目可靠**。如果库里的东西会莫名失效，用户就不敢依赖它。

代价是真实的：导入一个 2GB 的视频（虽然不支持）会占 4GB。缓解方式是导入失败逐条报告，不会静默失败。

### 4.2 `library.json` 格式

```json
{
  "version": 1,
  "entries": [
    {
      "id": "a1b2c3d4-0000-4000-8000-000000000001",
      "title": "长文测试 · 中文排版",
      "extension": "txt",
      "size": 18756,
      "sourcePath": "D:\\docs\\sample.txt",
      "storedName": "a1b2c3d4-...-000000000001.txt",
      "addedAt": 1793108107205,
      "lastOpenedAt": 1793107207205,
      "progress": { "version": 1, "ratio": 0.42, "fontSize": 17 }
    }
  ]
}
```

几个设计点：

- **`version` 字段**：为将来的格式迁移留出识别能力，而不是靠猜。
- **`sourcePath`**：只作为"这文件从哪来的"的人类提示。程序**永远不会再读它**。
- **`progress`**：完全不透明的 JSON。外壳只负责存取，内容由查看器定义（见 [5.4](#55-进度记忆)）。

### 4.3 写入可靠性

**原子写入**：先写 `library.json.tmp`，再 `rename` 覆盖目标。中途断电只会留下旧文件或新文件，不会是半个文件。

**损坏恢复**：读到无法解析的 JSON 时，把它备份成 `library.corrupt-<时间戳>.json`，然后以空库启动。

```
litearti: library.json was unreadable (expected value at line 1 column 1);
moved to .../library.corrupt-1793108339946.json
```

**为什么不直接报错退出**：一个损坏的元数据文件不应该让整个应用打不开。备份 + 空库启动，用户至少能用，证据也还在。

**BOM 容忍**：读取时会剥离 UTF-8 BOM。手工编辑或 PowerShell 的 `Set-Content -Encoding UTF8` 都会加 BOM，serde 会因此报"line 1 column 1"——那看起来像文件损坏，但实际只是编码前缀。

### 4.4 重复检测

判重条件是 **源路径相同 + 文件大小相同**。

这个规则刻意保守：它永远不会把两个不同的文件误判成重复。代价是"同一个文件从不同路径导入两次"会产生两个条目——这是可接受的，因为用户是主动这么做的。

---

## 五、四种内置查看器

### 5.1 文本阅读器

**编码探测顺序**（`text.rs`）：

```
1. 用户手动指定 → 无条件采用（想覆盖猜测的人应该得到他要求的）
2. 有 BOM        → UTF_8::decode 自己嗅探 UTF-8/UTF-16LE/UTF-16BE
3. 严格 UTF-8    → 成功就用
4. GB18030       → 兜底
```

**为什么 GB18030 排最后**：GB18030 几乎能接受任何字节序列。如果它排前面，会掩盖真正损坏的 UTF-8 文件——所有文件都会"解码成功"，只是内容是乱码。

**界面层的编码控制**：

- 显示实际使用的编码（`自动（GB18030）`）
- 可手动切 UTF-8 / GB18030 / Big5
- 当解码出现替换字符（`lossy`）时，提示"自动识别可能有误"

**排版**：

- 正文基准 17px，可调 13–28px
- 行高 1.9（中文长文需要更大行距）
- 行宽上限 `34em`（约 30–35 个汉字/行）
- 每个源文件行渲染成一个段落，空行给额外间距——这样硬换行的 TXT 也能读成块状，而不是一堵墙

**大小上限**：超过 32 MB 的文件会被截断，末尾追加提示。截断点落在**字符边界**上，不会把多字节字符切一半（早期版本会，导致整个文件按 GB18030 重新解码成乱码，见 [10.4](#104-已修复的早期缺陷2026-10)）。

**自动分章**（`viewers/txt/chapters.ts`）：识别 `第一章` / `第 12 章` / `Chapter 3` 这类标题，一章一屏 + 目录抽屉 + 章节导航。

规则刻意保守，因为两种错误代价不对称：错切会让一章从句子中间开始，比不分章更糟；漏切只是保持原样。所以要求行首开始、不超过 40 字、单位字后必须有分隔符、不能以句号结尾。少于 3 个标题不当作分章小说。

`第一节课上…`、`第二天，他走了。`、`第三章讲的是这个道理。` 都不会被误判。详见 [`txt-chapters.md`](txt-chapters.md)。

**识别不到时不改变任何行为**——整篇连续滚动，和加这个功能之前一模一样。

### 5.2 PDF 阅读器

**渲染模型**：每页一个 canvas，由 `IntersectionObserver` 按需渲染，离屏时释放。

```
IntersectionObserver (rootMargin: 600px)
  ├── 进入视口 → 渲染到 canvas
  └── 离开视口 → 清空 canvas、从 rendered 集合移除
```

这样内存占用与**当前可视页数**成正比，而不是与总页数。一本 1000 页的 PDF 不会一次性分配 1000 个 canvas。

**页面占位**：打开时先读所有页的尺寸，用占位 div 撑出正确宽高比。这样滚动条不会随着页面渲染而跳动。

**缩放**：`fitScale`（适合宽度，随窗口变化）× `zoom`（用户倍数，0.4–4）。渲染时再乘 DPR（上限 2），保证高分屏清晰。

**密码保护**：pdf.js 的 `onPassword` 回调分 `NEED_PASSWORD` 和 `INCORRECT_PASSWORD` 两种情况，后者会显示"密码不正确"而不是静默重新弹框。

**资源加载**：cmaps、标准字体、wasm、ICC 配置文件都在 `public/pdfjs/`，由 `scripts/copy-pdfjs-assets.mjs` 从 npm 包复制。这些是 pdf.js 按 URL 运行时加载的，不能被打包器合并。

**文本抽取**：同一套 pdf.js 也被导出功能复用（`export/converters/pdf.ts`），按 y 坐标分行、x 排序重组，保留页码锚点。

### 5.3 EPUB 阅读器

**这是项目里最复杂的一个查看器**，完整说明见 [`epub-viewer.md`](epub-viewer.md)。要点：

- **零依赖解压**：手写 ZIP 中央目录解析（含 ZIP64）+ 浏览器原生 `DecompressionStream`
- **双路径目录**：EPUB 3 nav 文档优先，EPUB 2 NCX 兜底
- **iframe 作为安全边界**：`sandbox="allow-scripts"`，**故意不给** `allow-same-origin`——书自带的 CSS 不能污染应用界面
- **两种渲染**：原版（书自己的 CSS）为默认，重排（应用阅读栏）可选
- **断网保证**：书里的远程图片、字体一律替换掉，不是"让它加载失败"——失败也是一次连接尝试
- **固定版式**（FXL）按页翻，支持 RTL

### 5.4 音频播放器

**刻意不做播放列表**。一个文件，一个播放器，记住位置。播放列表意味着队列管理，那是另一整套界面，MVP 没有挣到。

功能：播放/暂停、拖拽进度、±10 秒、倍速（0.75×–2×）、音量。

**关键实现细节**：`<audio>` 元素用 `v-if="src"` 保护。一个 `src=""` 的 audio 元素会立即触发 `error` 事件，导致明明正常的文件显示"无法播放"。

**URL 而不是路径**：`<audio src>` 必须用 `convertFileSrc()` 转换后的 asset 协议 URL。裸文件路径会被 webview 拒绝加载。

### 5.5 进度记忆

四个查看器各存各的，外壳不解释内容：

| 查看器 | payload | 说明 |
|---|---|---|
| 文本 | `{ version: 1, ratio: 0.42, fontSize: 17, chapter?: 3 }` | 比率；分章时带章号 |
| PDF | `{ version: 1, page: 12 }` | 页码 |
| EPUB | `{ version: 1, chapter: 3, ratio: 0.42, mode: 'original' }` | 章号 + 章内比率 |
| 音频 | `{ version: 1, time: 214.5, rate: 1.25 }` | 秒 + 倍速 |

**为什么存比率而不是 `scrollTop`**：窗口大小、字号、缩放都会变。存 `scrollTop / (scrollHeight - clientHeight)`，下次乘回去，在任何尺寸下都合理。

**写入时机**：全部走**尾沿节流**（文本 600ms、PDF 500ms、音频 800ms），并在组件卸载时同步刷一次。滚动时不会疯狂写盘。

**失败静默**：存进度失败绝不影响阅读。这是刻意的——进度是 best-effort。

**一个踩过的坑**：PDF 的进度恢复必须在 `loading` 变为 `false` **之后**执行。页面容器在 `v-else` 分支里，加载期间根本不存在，此时恢复调用会静默失效。恢复期间还要抑制 `onScroll` 的保存，否则中间态的滚动位置会把恢复值覆盖掉。

---

## 六、设计系统的落地

完整理由见 [`design-system.md`](design-system.md)。这里只列关键数字。

### 6.1 数值阶梯

```
间距   4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96
字号   12 · 13 · 15 · 17 · 20 · 24 · 30      (px，不用 em/rem)
字重   400 / 500 / 600                       (没有更细的)
行高   1.2 / 1.45 / 1.65 / 1.9               (与字号成反比)
阴影   e1 / e2 / e3                          (越大越柔 = 越近)
```

**所有数值必须来自 token**。我做过一轮审查，把硬编码的控件高度、滑块尺寸、滚动条宽度全部收进 token。需要新值时先加 token，再使用。

### 6.2 没有品牌色

整套界面是灰度的。层次由间距、尺寸、对比度、字重建立。

唯一的彩色是低饱和语义色：`--tone-danger: #8f3a34`、`--tone-warning: #7a5a1e`。面积小、饱和度低。

**删除按钮不用红色实心**。它是三级文字样式，hover 才透出一点红。理由：删除不是任何屏幕的主要任务，用大红按钮会让它比"打开文件"更抢眼——那是层次错误。

### 6.3 三级按钮

| 层级 | 视觉 | 用在哪 |
|---|---|---|
| 主要 | 实心深色 + 白字 + e1 阴影 | 每个屏幕区域**只有一个** |
| 次要 | 无填充 + 1px 轮廓 | 备选方案（确认移除） |
| 三级 | 看起来像链接，hover 才有背景 | 返回、移除、字号、编码 |

### 6.4 外壳：侧栏 + 三个板块

```
侧栏（208px，可折叠到 56px）
├── 看板   (DashboardView)      ← 默认首页
├── 资料库 (LibraryView)
├── 书源   (SourcesView)        ← 唯一联网的板块
└── 外观 / 折叠（底部）
        ↓ 从资料库点击条目
阅读页 (ReaderView) + 查看器     ← 全窗口，隐藏侧栏
        ↓ 返回 / Esc

        ↓ 从书源进入
书源 → 浏览 (SourceBrowseView) → 详情 (SourceDetailView) → 阅读 (SourceReaderView)
                                       ↑ 阅读同样全窗口
```

**折叠侧栏 = 最初的极简版**。不是两套界面，是一个组件的两种密度：`--sidebar-width` 208px ↔ `--sidebar-rail` 56px，同一个组件、同一条代码路径。

**阅读页不显示侧栏**，因为阅读是专注模式，不是应用的一个区块。本地书和书源章节在这一点上一致。

阅读页的顶栏只回答"我在哪 / 怎么离开"。任何属于阅读的控件都放在查看器内部，紧挨它影响的内容。

**书源板块的导航是显式状态而非路由**。`App.vue` 里四个 `ref`（sourceId / item / chapters / chapter）推导出当前在哪个屏幕。四个屏幕、一条线性路径，引入路由是比问题更重的机器。离开板块时状态重置，回来总是从列表开始。

### 6.5 看板只放真实数据

看板的所有数字都来自 `library.json` 已有字段（`extension` / `size` / `progress` / `addedAt` / `lastOpenedAt`），聚合逻辑在 `src/utils/dashboard.ts`。

需要新增埋点才能算的指标（阅读时长、连续阅读天数、阅读速度）**一律不做**——做了就是假数据，而假数据比没有看板更糟。

### 6.6 空状态

所有空状态都当"第一印象"做，不是占位符：

| 状态 | 说了什么 |
|---|---|
| 看板为空 | 导入后这里会显示什么 + 一个"去导入文件"的按钮 |
| 库为空 | 应用是什么、下一步做什么、文件去哪了、支持哪些格式 |
| 搜索无结果 | 回显查询词 + 一键清除 |
| 格式不支持 | 解释原因 + 指出可以注册查看器（把限制变成入口） |
| 没有书源 | 书源是什么 + 模板按钮（把"不知道怎么写"变成可操作） |
| 书源搜索无结果 | 回显关键词 + 提示可以换书源或粘贴网址 |

共同点：**都有下一步动作**。没有一个是"暂无数据"。

---

## 七、可扩展性：三个注册表

项目有三处"加东西不改外壳"的扩展点，写法刻意保持一致。完整契约见 [`viewer-contract.md`](viewer-contract.md)。

### 7.1 加一种文件格式

```ts
registerViewer({
  id: 'my-format',
  label: '我的格式',
  extensions: ['myf'],
  component: defineAsyncComponent(() => import('./MyViewer.vue')),
})
```

查看器组件只拿到两个 prop：`entry`（条目元数据）和 `host`（能力接口，5 个方法）。它拿不到文件系统、拿不到 Tauri、拿不到库。

**这条已经兑现过两次**：EPUB 和导出功能都是靠它加进来的，`App.vue` / `LibraryView` / `ReaderView` 一行没改。

### 7.2 加一种导出目标

```ts
registerConvertTarget({
  id: 'markdown',
  label: 'Markdown .md',
  extension: 'md',
  supports: ['epub', 'txt'],
  convert: async (input) => { /* ... */ },
})
```

菜单、store、管线都不需要改。详见 [`export.md`](export.md)。

### 7.3 自定义容器格式（漫画包）

"压缩固定文件结构的压缩包当作漫画"的场景，落在同一套接口里：

- 格式：`.lac`，根目录放 `litearti.json` 清单（标题、作者、页序、阅读方向）
- 回退：没有清单时按目录约定——解压后图片按文件名自然排序即页序
- 实现：ZIP 解压能力**已经有了**（`viewers/epub/zip.ts`，零依赖），不需要再引 `fflate` / `zip.js`
- `probe` 检查 ZIP 魔数 `PK\x03\x04` 区分于 EPUB

> **修订**：原文此处写"前端用 fflate / zip.js 解压"、"Rust 侧故意不解压"。EPUB 支持上线后，项目已经有了自己的 ZIP 读取器，所以漫画包可以直接复用，不必新增依赖。Rust 侧仍然不解压——大包的限制由 200 MB 上限兜住。

---

## 八、面向安卓的移植设计

目标不是"现在支持安卓"，而是"将来移植时改动最小"。已经做到的：

### 8.1 能力抽象

查看器只依赖 5 个能力，且**都不假设文件系统路径**：

| 能力 | 桌面实现 | 安卓需要 |
|---|---|---|
| 选文件 | dialog 插件返回路径 | SAF，返回 content URI |
| 读字节 | `fs::read` | `ContentResolver.openInputStream` |
| 解码文本 | `encoding_rs` | **同一套 Rust 代码可复用** |
| 存进度 | `library.json` | 同一份 JSON，换目录 |
| 播放音频 | `convertFileSrc` → asset URL | 内容 URI 或 blob URL |

### 8.2 单点收敛

改平台只需改 `src/api/library.ts` 一个文件。查看器、store、设计系统、路由逻辑一行都不用动。

### 8.3 路径无关的元数据

`library.json` 里**没有绝对路径依赖**。`storedName` 是 UUID 文件名，`sourcePath` 只是提示信息，程序不会读它。

### 8.4 已知的移植点

- `entryPath()` 在安卓上没有意义，应返回内容 URI 或抛错。新查看器**优先用 `entryUrl()`**。
- 音频的 asset 协议需要换成对应平台的方案。
- **书源板块的网络层可以直接复用**：`net.rs` 是纯 Rust，与平台无关。
- **书源的沙箱 iframe 需要注意**：安卓 WebView 对 `sandbox` 属性的支持与桌面一致，但 `srcdoc` 的加载时序可能不同——`waitForFrame` 已经是轮询而非事件，这一点已经防住。
- **`open_external` 需要平台分支**：目前 Windows 用 `rundll32`，macOS 用 `open`，Linux 用 `xdg-open`；安卓需要 `Intent.ACTION_VIEW`。
- 当前没有做响应式断点（只保证桌面窗口 ≥ 680px 宽），移动端布局需要重新设计。

---

## 九、构建与运行

### 9.1 环境要求

| 项 | 要求 |
|---|---|
| Node | ≥ 20 |
| pnpm | ≥ 8 |
| Rust | ≥ 1.77 |
| Windows | MSVC Build Tools + WebView2 运行时（Win10/11 通常已内置） |

### 9.2 命令

```bash
pnpm install        # 安装依赖
pnpm app:dev        # 启动桌面应用（首次编译 Rust 约 1–3 分钟）
pnpm app:build      # 构建 release 二进制（不打包安装程序）
```

开发辅助：

```bash
pnpm dev            # 只启前端（浏览器预览，无文件系统能力）
pnpm build          # 类型检查 + 前端构建
pnpm prepare:pdfjs  # 重新复制 pdf.js 运行时资源
```

> **当前阶段不产出安装包。** `src-tauri/tauri.conf.json` 里 `bundle.active` 为 `false`，构建只生成可执行文件本体，跳过 NSIS 打包（省去下载打包器与签名步骤）。要恢复安装包，把该字段改回 `true` 即可。

### 9.3 构建产物

实测（Windows，release）：

| 产物 | 路径 | 体积 |
|---|---|---|
| **可执行文件** | `src-tauri/target/release/litearti.exe` | **7.6 MB** |
| 前端 `dist/` | `dist/`（已内嵌进 exe，无需单独分发） | 5.3 MB（其中 pdf.js 资源约 4.6 MB） |
| 前端 JS（首屏） | — | 179 KB |
| pdf.js 主包 | — | 474 KB（gzip 142 KB，**懒加载**） |

各查看器与引擎都是**独立 chunk**，只在首次用到时加载：

| chunk | 体积 | 何时加载 |
|---|---|---|
| `TextReader` | 7.6 KB | 打开文本文件 |
| `PdfReader` | 6.9 KB | 打开 PDF |
| `AudioPlayer` | 4.8 KB | 打开音频 |
| `EpubReader` | 19.4 KB | 打开 EPUB |
| `pdf`（引擎） | 474 KB | 打开 PDF 或导出 PDF 为文本 |

**分发方式**：直接拷贝 `litearti.exe` 即可运行，无需安装。前端资源（含 pdf.js）在构建时已嵌入二进制。

只读 TXT 的用户不会为 PDF 或 EPUB 付出任何启动成本。

### 9.4 pdf.js 资源

`scripts/copy-pdfjs-assets.mjs` 把 `node_modules/pdfjs-dist` 里的运行时资源复制到 `public/pdfjs/`：

```
cmaps/            1.11 MB   中文等 CJK 字体映射
standard_fonts/   0.76 MB   标准 14 字体
wasm/             1.47 MB   JPEG2000 等解码器
iccs/             0.01 MB   色彩配置文件
build/pdf.worker.min.mjs    1.21 MB  worker
```

脚本是幂等的：靠 `.version` 标记文件判断是否需要重新复制。

---

## 十、已知限制与后续方向

### 10.1 明确没做的

这些**没有半成品痕迹留在界面上**——界面上看不到任何"即将推出"或灰掉的入口。

| 未做 | 原因 |
|---|---|
| 书签、标注、笔记 | 需要一整套数据模型和交互，MVP 没挣到 |
| 播放列表 / 音频连播 | 队列管理是另一个界面 |
| 自定义漫画包解析 | 接口和文档已就绪，实现是增量工作 |
| 移动端布局 | 只保证桌面（看板在 900px 以下会堆叠，但这不是移动端布局） |
| PDF 文本选择 / 搜索 / 目录 | pdf.js 支持，但交互层工作量大 |
| 文件重命名 / 标签 / 分组 | 库的元数据模型需要扩展 |
| 阅读时长 / 连续天数统计 | 需要新增埋点，不做假数据 |
| 整库备份 / 恢复 | 与导出不同，需要打包 `library.json` 与版本迁移 |
| 内置真实书源 | 站点会变，维护成本在用户；引擎已完备，附一份样例 |
| 书源订阅 URL | 引入"从网上拿代码"的二次风险 |
| 书源 Cookie / 登录态 | 需要凭据存储与安全模型，另立功能 |

### 10.2 已知的技术限制

| 限制 | 影响 | 可能的解法 |
|---|---|---|
| PDF 整文件读进内存 | 超大 PDF（>100 MB）会占用大量内存 | 改用 Rust 侧流式读取 + range 请求 |
| 文本上限 32 MB | 更大的文件被截断（截断点已保证落在字符边界，不会乱码） | 分页加载 |
| EPUB 上限 200 MB | 整包读进内存，超限明确拒绝 | Rust 侧按条目流式读取 |
| 复制式导入 | 大文件占双份空间、导入慢 | 提供"引用式"选项 |
| pdf.js 渲染性能 | 矢量密集页面较慢 | 换原生引擎（接口已隔离） |
| 无响应式断点 | 窄窗口布局不变 | 加断点（移动端前置工作） |
| 单一语言 | 只有中文 | i18n 结构已就绪，加字典即可 |
| TXT 分章靠标题格式 | 无编号的标题识别不到 | 保守是刻意的，见 [`txt-chapters.md`](txt-chapters.md) |
| 书源无缓存 | 每次搜索都请求站点 | 内存缓存 + TTL |
| 书源只抓单页 | 不能自动翻页聚合 | 加 page 循环与去重 |
| 书源二进制下载 | 直链拿的是文本响应，MP3/PDF 会损坏 | Rust 侧返回原始字节 |
| 书源进度按 URL 记 | 章节 URL 变了就丢进度 | 改按章节序号记录 |

### 10.3 验证状态

| 项 | 状态 |
|---|---|
| `vue-tsc --noEmit` | ✅ 无错误 |
| `cargo test` | ✅ 63 项（编码探测、截断边界、资料库增删改、并发、导出、网络规则、书源存储、下载导入、URL 协议） |
| `vite build` | ✅ 通过 |
| `tauri build` | ✅ 通过，release **7.6 MB** |
| 四种查看器实际运行 | ✅ 逐一验证（GB18030 中文、PDF 渲染、EPUB 原版/重排、音频播放、进度恢复） |
| TXT 分章实际运行 | ✅ 分章渲染、章节导航、目录抽屉、跳章、进度记章号 |
| 书源板块实际运行 | ✅ 板块渲染、真实 IPC 持久化、沙箱跨源隔离、`file:` 拒绝 |
| 书源真实站点 | ✅ bqg5555：搜索 → 封面补全 → 详情 → 分页章节；URL 直接打开 |
| 导出实际运行 | ✅ 原字节拷贝、文本降级、重名递增、文件名消毒 |
| release 二进制独立启动 | ✅ 直接运行 `litearti.exe`，界面与功能正常 |
| NSIS 安装包 | 暂不产出（`bundle.active: false`，本阶段只交付二进制） |

### 10.4 已修复的早期缺陷（2026-10）

这三条在 beta 阶段被发现并修掉，记录在此以免重犯。

**① 32 MB 截断切断多字节字符**

`read_text` 原先按字节偏移 `bytes[..MAX_TEXT_BYTES]` 截断。切点落在 UTF-8 多字节字符中间时，`std::str::from_utf8` 整体失败 → 落到 GB18030 兜底 → **整个文件变乱码**，且 `lossy` 可能为 false，界面不会提示。CJK 文本命中概率不低。

现在 `text::floor_char_boundary` 先回退到字符边界再切，代价至多 3 字节。

**② 删除顺序可能导致悬空条目**

原先先 `fs::remove_file` 再 `save`。若 `save` 失败，元数据里留着条目但文件已没了，每次打开都报"找不到条目对应的文件"，用户无法修复。

现在**先落盘再删文件**。两种失败不对称：save 失败时文件还在（什么都没发生）；unlink 失败只留孤儿文件，用户不可见。导入路径同理——`save` 失败会回滚已复制的文件，不留不可见的孤儿。

**③ 并发读改写丢更新**

原先每个 command 都 `open_library()` 新建实例，全量 load/save，无锁。Tauri 在线程池上派发 command，所以"导入时另一个查看器正在存进度"会各自读到旧列表、各写各的，后写的覆盖先写的。

现在 `Library` 作为 Tauri 托管状态，外面套 `Mutex`。**锁只覆盖元数据**：`stored_path()` 返回路径而非字节，大文件读取在锁外进行，不会阻塞进度写入。互斥锁中毒（线程 panic）会被恢复——状态在磁盘上，内存里的 guard 没有值得保留的东西。

### 10.5 如果继续做，优先级建议

1. **漫画包查看器** — 接口和格式文档已就绪，是"自定义数据"的第一个真实用例
2. **PDF 流式读取** — 解除大文件限制，需要动 Rust
3. **响应式断点** — 移动端移植的前置工作
4. **书签** — 需要先想清楚数据模型（跟进度是两回事）
5. **书源缓存** — 减少对站点的重复请求

---

## 十一、书源

项目里唯一联网的板块。用 JSON 描述怎么从一个网站取书，导入后即可搜索、阅读、下载。

设计要点（设计取舍见 [`book-sources.md`](book-sources.md)，**字段级参考见 [`book-source-api.md`](book-source-api.md)**）：

- **格式由校验器把关**：手写校验器，错误指向具体字段（`search.fields.title 缺失`），比通用 schema 报错有用
- **三种选择器**：JSONPath 子集、CSS、受限 JS。选择器前缀是封闭集合，schema 能约束
- **JS 在隔离 iframe 里跑**：`sandbox="allow-scripts"`，故意不给 `allow-same-origin`，所以摸不到父页面和 `__TAURI_INTERNALS__`；3 秒超时销毁重建
- **网络只走 Rust**：仅 GET/POST、仅 http(s)、10 MB 上限、不维持 cookie、重定向到非 web 协议一律拒绝
- **书源与资料库分离**：`sources/` 独立存放，删书源不影响已导入的书

**一处诚实的边界**：schema 只能约束结构，`@js:` 里写什么它管不了。这是"严格约束"与"允许 JS"之间的固有矛盾，靠静态检查 + 沙箱 + 超时三层缓解，而不是靠 schema 假装解决。文档里写明了。

### 11.1 引擎替书源作者处理的三件事

写书源时不必自己解决，但知道它们存在会少踩坑：

| 能力 | 说明 |
|---|---|
| **段落保留** | 提取正文时识别块级元素并换行，不会把整章压成一行；`chapter.content` 是"取全部匹配"语义，所以 `css:#content p` 能排除夹在段落旁的导航文字 |
| **分页跟随** | 声明 `chapter.nextUrl` 后自动跟到没有下一页为止（上限 20 页，且记录已访问 URL 防死循环） |
| **封面补全** | 搜索列表没图时，后台逐本从详情页补，串行 + `delayMs` 间隔，最多 24 张 |

### 11.2 与既有设计的一致性

书源复用了项目里已经成立的三条模式：

| 模式 | 书源怎么用 |
|---|---|
| 单一 IPC 出口 | 新增的 command 全部经 `api/library.ts` 暴露 |
| 注册表驱动 | 选择器按前缀分派，加一种语法不改引擎 |
| 不造假数据 | 资源类型、章节数、下载结果都来自真实解析 |

### 11.3 已知限制

| 限制 | 影响 | 可能的解法 |
|---|---|---|
| 选择器能力有限 | 需签名的站点表达不了 | 已用受限 JS 覆盖大部分 |
| 单页抓取 | 不能自动翻页聚合 | 加 page 循环与去重 |
| 无缓存 | 每次搜索都请求站点 | 内存缓存 + TTL |
| 二进制下载受限 | MP3/PDF 直链会损坏 | Rust 侧返回原始字节 |
| 章节 URL 变了丢进度 | 源更新后进度失效 | 按章节序号记录 |

---

## 十二、导出

把书本体写成文件，并可以降级成纯文本。完整说明见 [`export.md`](export.md)。

**两种目标**：原始文件（原字节拷贝，全格式）、纯文本（文本系无损 / PDF 有损 / EPUB 保留标题层级）。

**架构**：又一个注册表（`export/registry.ts`），与查看器同构。加一种目标格式 = 注册一个描述符。

**管线**：先全部转换、再统一写盘。反过来做会在第 7 条出错时留下半批文件，而人无从判断哪些是好的。

**写盘三条铁律**（`export.rs`）：绝不覆盖（`name (2).txt` 递增）、文件名消毒、原子写。

**边界**：这是**单向、有损**的降级导出，不是格式互转。TXT 不会变成 PDF。

---

## 附：文档索引

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 快速开始、命令、功能清单 |
| [`epub-viewer.md`](epub-viewer.md) | EPUB：零依赖解压、双路径目录、iframe 安全边界 |
| [`export.md`](export.md) | 导出：原字节拷贝、文本降级的边界、写盘安全规则 |
| [`book-sources.md`](book-sources.md) | 书源：设计取舍、沙箱与网络安全 |
| [`book-source-api.md`](book-source-api.md) | 书源 API 参考：字段级说明、选择器语法、校验错误全表、引擎接口 |
| [`txt-chapters.md`](txt-chapters.md) | TXT 分章：识别规则、误判防护、进度兼容 |
| [`login-credentials.md`](login-credentials.md) | 登录 Cookie（**搁置**）：现状、删除记录、剩余 bug 与恢复步骤 |
| [`legado-conversion.md`](legado-conversion.md) | 从 Legado（阅读）书源转换：映射表与转不了的规则 |
| [`viewer-contract.md`](viewer-contract.md) | 查看器接口契约、自定义容器格式、安卓备忘 |
| [`design-system.md`](design-system.md) | 设计决策与理由、反模式清单 |
