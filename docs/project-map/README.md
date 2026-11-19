# 项目地图：结构、架构与取舍

这套文档是为了**日后审计代码**而写的。它回答三个问题：

1. **每个目录是干什么的** —— 什么该放进去，什么不该
2. **架构是什么** —— 哪些边界是硬的、在哪里被强制
3. **为什么这么做** —— 每个决定拒绝了什么替代方案

第 3 点最重要。代码审计最容易犯的错是"看到奇怪的做法就改掉"，而那些做法往往是为了修一个真实 bug 才变成那样的。这里有记录。

---

## 怎么读

| 想知道 | 读 |
|---|---|
| 某个文件夹干什么的 | [01-structure.md](01-structure.md) |
| 层与层之间怎么通信、边界在哪 | [02-architecture.md](02-architecture.md) |
| 某个设计为什么长这样 | [03-decisions.md](03-decisions.md) |
| 要审代码，从哪开始、查什么 | [04-audit-guide.md](04-audit-guide.md) |

如果只想看结论，读 [04-audit-guide.md](04-audit-guide.md) 的「不变量清单」和「已知弱点」。

---

## 一句话概括这个项目

一个 **Tauri 2 + Vue 3** 的本地优先阅读器：读本地文件（TXT/PDF/EPUB/音频），联网只为了从用户自己添加的「源」里取内容，外加一个 Bangumi 资料板块。**同一个代码库可以编译出 Windows 桌面版和 Android APK**。

**三条贯穿全局的约束**，其余所有设计都是从它们推出来的：

| 约束 | 含义 | 强制执行的地方 |
|---|---|---|
| **网络只走 Rust** | 前端一行 `fetch` 都没有 | `net.rs`、`bangumi.rs`、`rules_mirror.rs`、`stream.rs` |
| **Tauri 只在适配层** | 视图不直接碰 `invoke` | `src/api/`、`src/discover/api.ts`、`src/export/pickDirectory.ts`、`src/sources/mirror.ts` |
| **不用 UI 组件库** | 视觉完全由 `tokens.css` 长出来 | `src/styles/tokens.css` + `docs/design-system.md` |

---

## 快速事实

| | |
|---|---|
| 前端运行时依赖 | **6 个**（vue, pinia, @tauri-apps/api, plugin-dialog, hls.js, pdfjs-dist） |
| Rust 直接依赖 | **11 个核心** + 平台条件依赖（见 01-structure） |
| Rust 模块 | 20 个 + `sniff/` 子目录 4 个 |
| 前端 `src` 子目录 | 13 个 |
| 视图 | 13 个 |
| 验证脚本 | **35 个 `verify-*` + 4 个 `shots-*`** |
| 单元测试 | 176 个（`cargo test`） |
| 设计 token | 全部在 `src/styles/tokens.css`，组件里没有硬编码数值 |
| 支持平台 | Windows（x64）、Android（arm64 / armv7 / x86 / x86_64） |

依赖数量是刻意控制的：加一个 crate 或 npm 包要在 `docs/` 里有理由。

---

## 目录一览（展开在每个文件夹的文档里）

```
litearti/
├── src/                 Vue 前端（13 个子目录）
├── src-tauri/src/       Rust 后端（18 个模块）
├── scripts/             验证脚本与生成工具（不打包进应用）
├── docs/                文档（本目录是其中一部分）
├── sources/             源文件样本（运行时数据不在这里）
├── importable-sources/  可直接导入的示例源
├── public/              静态资源（pdfjs 等，构建时原样拷贝）
└── demo/                测试用的样例 EPUB / PDF
```

---

## 文档本身的状态

这份地图随代码走。**如果代码和这里说的不一致，以代码为准，然后回来修文档**——但先确认是不是某一方真的错了，因为有几条约束是刻意为之的，破坏它们会引入已经修过的 bug。

每条"为什么"都在 `03-decisions.md` 里带上了**被拒绝的替代方案**。如果没有写被拒绝了什么，那个决定大概还没被真正思考过，值得怀疑。
