# litearti

一个安静的桌面阅读器：读 TXT、看 PDF、读 EPUB、听音频，另有书源板块可联网找书。

**阅读不联网**：本地书的打开、渲染、进度记忆全程离线，不同步、不收集数据。

**书源板块会联网**，且只访问你添加的书源所指向的网站——不上传任何本地数据。这是唯一会离开这台机器的功能，边界写在 [`docs/book-sources.md`](docs/book-sources.md)。

**技术栈**：Tauri 2 + Vue 3 + TypeScript + Vite。没有 UI 组件库——界面完全由 `src/styles/tokens.css` 里的设计系统长出来。运行时前端依赖 5 个，Rust 直接依赖 7 个。

---

## 快速开始

```bash
pnpm install
pnpm app:dev      # 启动桌面应用（首次会编译 Rust，约 1-3 分钟）
```

其他命令：

```bash
pnpm dev          # 只启动前端（浏览器预览，无文件系统能力）
pnpm build        # 类型检查 + 前端构建
pnpm app:build    # 构建 release 二进制（不打包安装程序）
```

**环境要求**：Node ≥ 20、pnpm ≥ 8、Rust ≥ 1.77、Windows 上需要 MSVC Build Tools 和 WebView2 运行时（Win10/11 通常已内置）。

---

## 支持的格式

| 类型 | 扩展名 |
|---|---|
| 纯文本 | `.txt` `.md` `.log` `.text` `.csv` `.json` `.yml` `.yaml` |
| PDF | `.pdf` |
| EPUB | `.epub` |
| 音频 | `.mp3` `.m4a` `.aac` `.flac` `.wav` `.ogg` `.opus` `.weba` |

导入对话框只列出常用扩展名，但**这是过滤器，不是能力边界**。加一种新格式只需注册一个查看器，见 [`docs/viewer-contract.md`](docs/viewer-contract.md)。

---

## 功能

**看板**（默认首页）
- 条目总数、占用空间、在读、本周新增
- 格式分布（横向条形图，灰度，长度即数据）
- 阅读状态：未开始 / 在读 / 已读完
- 最近阅读，点击直接打开
- 所有数字都来自 `library.json` 已有字段，**没有假数据**

**外壳**
- 侧栏可折叠：208px（图标+文字）↔ 56px（仅图标）
- **折叠后就是极简模式**，同一个组件的两种密度
- 主题：浅色 / 深色 / 跟随系统，持久化，跟随系统时实时响应
- Esc 从阅读页返回

**资料库**
- 导入文件（按钮 / 拖拽），**复制**进应用数据目录
- 按最近活动排序，标题搜索
- 行内显示进度（"已读 42%" / "第 12 页" / "第 3 章" / "听到 3:24"）
- 移除（删除库内副本，原文件不动）
- 导入失败逐条报告，不中断整批

**TXT / 纯文本**
- 编码自动探测：BOM → UTF-8 → GB18030
- 手动切换 UTF-8 / GB18030 / Big5
- 字号 13–28px
- 滚动位置按**比率**记忆（换窗口尺寸依然准确）
- **自动分章**：识别 `第一章` / `第 12 章` / `Chapter 3` 等标题，一章一屏 + 目录抽屉；
  识别不到就保持整篇滚动，不会误切

**PDF**
- pdf.js 渲染，逐页懒加载 + 离屏释放（内存与可视页数成正比）
- 翻页、缩放、适合宽度
- 页码记忆
- 加密 PDF 密码输入

**EPUB**
- **原版**：书自带的 CSS 原样渲染，出版方设计的排版、字体、插图都在
- **重排**：丢掉出版商样式，换成应用自己的阅读栏，字号 13–28px 可调
- 目录（EPUB 3 nav / EPUB 2 NCX 都支持），左侧抽屉，选完自动收起
- 一章一屏，章末有「下一章」，方向键可翻章
- 内嵌图片（封面、插图）按需解压并缓存
- 脚注 / 内部链接跳转
- 固定版式（FXL）按页翻，支持 RTL 阅读方向
- DRM 检测：识别出加密书并说明原因，不做解密
- 零依赖解压：手写 ZIP 中央目录解析 + 浏览器原生 `DecompressionStream`

**音频**
- 播放/暂停、拖拽进度、±10 秒
- 倍速 0.75×–2×、音量
- 位置与倍速记忆

**导出**
- 资料库 `...` → 导出，勾选条目后写入你选的文件夹
- **原始文件**：原字节拷贝，全部格式支持
- **纯文本 .txt**：文本系无损；PDF 按页抽取（有损，保留页码锚点）；EPUB 保留标题层级（复用查看器解析）
- 重名自动递增 `name (2).txt`，绝不覆盖
- 文件名消毒（非法字符、Windows 保留名、长度）
- 原子写，中断不会留下半个文件
- 目标格式可注册扩展，见 [`docs/export.md`](docs/export.md)

**书源**（唯一联网的板块）
- 用 JSON 定义书源，导入后即可搜索该网站
- 三种选择器：JSONPath（JSON API）、CSS（HTML 页面）、受限 JS（沙箱内计算）
- 严格校验：结构、类型、枚举、选择器前缀、URL 协议、危险标识符
- 资源卡片显示**封面 + 标题 + 类型标签**（小说 / 漫画 / 听书 / 视频）
- 搜索列表没图时，从详情页后台补封面
- **可以直接粘贴书籍目录页网址**（如 `https://…/xs/250929/`）当作结果打开
- **「访问网站」按钮**：在系统浏览器里打开书源主页，不占用应用窗口
- 详情页章节列表 → 在线阅读（排版与本地 TXT 一致）或下载导入资料库
- JS 在 `sandbox="allow-scripts"`（无 `allow-same-origin`）的 iframe 里跑：摸不到父页面、摸不到 Tauri 内部对象、3 秒超时
- 网络只走 Rust：仅 GET/POST、仅 http(s)、10 MB 上限、不维持 cookie
- 详见 [`docs/book-sources.md`](docs/book-sources.md)

**其他**
- 全中文文案，key 化（`src/i18n/`），加语言只需加字典

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/project-overview.md`](docs/project-overview.md) | **项目详细介绍**：架构、数据模型、技术选型理由、限制与后续方向 |
| [`docs/epub-viewer.md`](docs/epub-viewer.md) | EPUB 查看器：零依赖解压、双路径目录、iframe 安全边界、断网保证 |
| [`docs/export.md`](docs/export.md) | 导出：原字节拷贝、PDF/EPUB → 文本的降级边界、写盘安全规则 |
| [`docs/book-sources.md`](docs/book-sources.md) | 书源：设计取舍、沙箱与网络的安全边界 |
| [`docs/book-source-api.md`](docs/book-source-api.md) | **书源 API 参考**：字段级说明、选择器语法、校验错误全表、引擎接口 |
| [`docs/txt-chapters.md`](docs/txt-chapters.md) | TXT 分章：识别规则、误判防护、进度兼容 |
| [`docs/login-credentials.md`](docs/login-credentials.md) | 登录 Cookie（**搁置**）：已实现什么、删除了什么、剩余 bug 与恢复步骤 |
| [`docs/legado-conversion.md`](docs/legado-conversion.md) | 从 Legado（阅读）书源转换：映射表、转不了的规则、已跑通的样例 |
| [`docs/viewer-contract.md`](docs/viewer-contract.md) | 查看器接口契约、自定义容器格式（漫画包）、安卓移植备忘 |
| [`docs/design-system.md`](docs/design-system.md) | 间距/字号/阴影阶梯，以及每条设计规则的落地方式 |

---

## 项目结构

```
src/
├── api/library.ts        ← 唯一与 Tauri 通信的模块（21 个函数）
├── components/
│   ├── AppSidebar.vue    ← 可折叠侧栏（折叠 = 极简模式）
│   ├── EmptyLibrary.vue
│   ├── ImportFeedback.vue
│   ├── ExportMenu.vue    ← 头部 `...` 菜单与格式选择
│   ├── ExportFeedback.vue
│   ├── SourceCard.vue    ← 书源资源卡片（封面 / 标题 / 类型）
│   └── SourceFormFeedback.vue
├── export/               ← 导出引擎，与外壳解耦
│   ├── registry.ts       ← 目标格式注册表（与 viewers/registry 同构）
│   ├── builtins.ts       ← 内置目标：原始文件 / 纯文本
│   ├── pipeline.ts       ← 先全部转换、再统一写盘
│   ├── naming.ts         ← 文件名消毒与重名递增（与 Rust 同规则）
│   ├── pickDirectory.ts
│   └── converters/
│       ├── text.ts       ← 文本系，无损
│       ├── pdf.ts        ← 按页抽取，有损
│       └── epub.ts       ← 复用 EPUB 解析，质量最好
├── sources/              ← 书源引擎，唯一联网的模块
│   ├── schema.ts         ← 书源格式定义 + 手写校验器
│   ├── selector.ts       ← JSONPath 子集 / CSS / 属性提取
│   ├── sandbox.ts        ← 隔离 iframe，执行受限 JS
│   ├── engine.ts         ← 搜索 / 详情 / 章节编排（fetcher 可注入）
│   └── download.ts       ← 直链下载或章节拼接
├── i18n/index.ts         ← 文案，key 化管理
├── stores/
│   ├── library.ts        ← Pinia：条目与导入状态
│   ├── export.ts         ← Pinia：选择模式与导出状态
│   ├── sources.ts        ← Pinia：书源与书源阅读进度
│   └── theme.ts          ← 主题：light / dark / system
├── styles/
│   ├── tokens.css        ← 设计系统的唯一数值来源
│   └── base.css          ← 元素默认样式 + 按钮三级层次
├── types/viewer.ts       ← 查看器契约（核心接口）
├── utils/
│   ├── format.ts         ← 尺寸/时间/相对时间格式化
│   └── dashboard.ts      ← 看板聚合（纯函数，无副作用）
├── viewers/
│   ├── registry.ts       ← 扩展名 → 查看器的路由
│   ├── builtins.ts       ← 内置格式登记（唯一的格式清单）
│   ├── host.ts           ← ViewerHost 的实现
│   ├── TextReader.vue
│   ├── PdfReader.vue
│   ├── AudioPlayer.vue
│   ├── EpubReader.vue    ← EPUB 外壳：工具栏 / 目录 / 翻章 / 进度
│   ├── txt/
│   │   └── chapters.ts   ← TXT 分章检测（保守，宁可不切）
│   └── epub/             ← EPUB 引擎，与外壳解耦
│       ├── zip.ts        ← 零依赖 ZIP 读取（中央目录 + ZIP64）
│       ├── package.ts    ← container/OPF/manifest/spine/NCX/nav 解析
│       ├── resources.ts  ← 图片与 CSS 重写、消毒、断网保证
│       └── theme.ts      ← 重排模式的阅读样式（从 tokens 生成）
└── views/
    ├── DashboardView.vue      ← 看板（默认首页）
    ├── LibraryView.vue        ← 资料库列表
    ├── ReaderView.vue         ← 本地阅读页
    ├── SourcesView.vue        ← 书源管理
    ├── SourceBrowseView.vue   ← 书源搜索与卡片网格
    ├── SourceDetailView.vue   ← 书源详情与章节
    └── SourceReaderView.vue   ← 书源在线阅读

src-tauri/src/
├── lib.rs                ← 15 个 command
├── library.rs            ← 托管式资料库（导入/删除/进度/原子写入）
├── export.rs             ← 导出写盘（消毒 / 重名递增 / 原子写）
├── sources.rs            ← 书源与书源进度的存储
├── net.rs                ← 书源 HTTP（协议白名单 / 超时 / 体积上限）
├── download.rs           ← 下载导入（临时文件 → 复用导入 → 清理）
├── external.rs           ← 在系统浏览器打开 URL（仅 http/https）
├── text.rs               ← 编码探测（UTF-8 / GB18030 / BOM）
├── model.rs              ← 数据形状
└── error.rs              ← 统一错误

docs/                     ← 见上方文档表
scripts/                  ← pdf.js 资源复制、图标生成、验证脚本
sources/                  ← 可直接导入的书源 JSON（样例，不是内置）
```

### 验证脚本

离线套件，不需要跑桌面应用也不需要联网：

```bash
node scripts/verify-zip.mjs             # ZIP 解压：stored/deflate/二进制/损坏输入
node scripts/verify-epub-package.mjs    # OPF/NCX/nav 解析、EPUB 2 与 3 两条路径
node scripts/verify-epub-e2e.mjs        # 真实 .epub 全链路：解压→解析→章节 HTML
node scripts/verify-export-convert.mjs  # 导出：注册表 / 命名 / TXT / PDF / EPUB 转换
node scripts/verify-source-schema.mjs   # 书源校验器：结构 / 语义 / 错误信息
node scripts/verify-source-selector.mjs # 选择器：JSONPath 子集 / CSS / 属性提取
node scripts/verify-source-engine.mjs   # 引擎：模板 / 搜索 / 详情 / 章节 / 分页（注入 fetcher）
node scripts/verify-source-sandbox.mjs  # 沙箱：属性与防护的静态检查
node scripts/verify-txt-chapters.mjs    # TXT 分章：标题识别与误判防护
node scripts/make-sample-epub.mjs       # 生成 demo/sample.epub
node scripts/make-sample-pdf.mjs        # 生成 demo/sample.pdf
```

打包应用上的端到端验证（需要先带调试端口启动）：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
  src-tauri/target/release/litearti.exe

node scripts/verify-ui-epub.mjs         # EPUB：章节渲染、目录、重排、进度
node scripts/verify-ui-sources.mjs      # 书源板块：渲染、IPC 持久化、沙箱跨源
node scripts/verify-ui-export.mjs       # 导出菜单与选择模式
node scripts/verify-ui-features.mjs     # TXT 分章 + 访问网站 + 粘贴网址
node scripts/verify-ui-credentials.mjs  # 登录凭证 IPC 与界面（功能本身搁置，见文档）
```

以下两个会访问真实网站，**不属于离线回归套件**——站点不可达或改版时会失败，这是预期行为：

```bash
node scripts/verify-source-live.mjs     # sources/bqg5555.json 全链路（搜索→封面→详情→分页章节）
node scripts/verify-ui-bqg.mjs          # 打包应用 + 真实站点
```

---

## 三个关键设计决定

### 1. 托管式资料库

导入即**复制**文件进 `%APPDATA%/app.litearti.reader/library/files/`，元数据存同目录 `library.json`。

**代价**：占双份空间，导入大文件需要时间。
**收益**：源文件移动、重命名、删除都不影响资料库。这是"库"这个心智模型的必要条件——如果条目会莫名失效，用户就不敢依赖它。

`library.json` 用**临时文件 + rename** 原子写入；读到损坏的 JSON 会备份成 `library.corrupt-<时间戳>.json` 并以空库启动，而不是让应用打不开。

资料库在 Rust 侧是 Tauri 托管状态 + `Mutex`，因为每个命令都是全量读改写——无锁时"导入的同时另一个查看器在存进度"会丢更新。

### 2. 格式归属由前端注册表决定

Rust 侧**只知道扩展名字符串**，不知道什么是 PDF。哪个扩展名归哪个查看器，完全由 `src/viewers/registry.ts` 决定。

这是"加格式不改外壳"的前提，也是安卓移植时不用动 Rust 的原因。EPUB 和导出功能都是靠它加进来的，外壳一行没改。

### 3. 联网被隔离在一个板块里

书源是唯一会联网的功能，而且：

- 网络只走 Rust（`net.rs`），只允许 GET/POST、只允许 http(s)
- 书源里的 JS 在 `sandbox="allow-scripts"`（**无** `allow-same-origin`）的 iframe 里跑，摸不到应用和 Tauri
- 书源数据存在 `sources/`，与 `library/` 完全分开

看板、资料库、本地阅读全程离线，这一点没有被书源功能动摇。

---

## 明确没做的

这些**没有**半成品痕迹留在界面上——看不到"即将推出"或灰掉的入口：

书签 / 标注 / 笔记 · 播放列表 · 自定义漫画包解析 · 移动端布局 · PDF 文本选择与搜索 · 文件重命名与标签 · 阅读时长统计 · 整库备份 · 内置书源 · 书源订阅

完整清单和原因见 [`docs/project-overview.md` 第十节](docs/project-overview.md#十已知限制与后续方向)。
