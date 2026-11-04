/**
 * i18n scaffold.
 *
 * There is exactly one locale today, but every string is addressed by key from
 * the start. That costs nothing now and means adding a second language is a
 * matter of adding a dictionary — not hunting strings through components.
 *
 * Interpolation is intentionally tiny: `{name}` placeholders, no plural rules
 * or nesting yet. If a second language needs those, this is the one file to
 * upgrade, and call sites stay unchanged.
 */

const zhCN = {
  'nav.primary': '主导航',
  'nav.dashboard': '看板',
  'nav.library': '资料库',
  'nav.sources': '书源',
  'nav.collapse': '收起侧栏',
  'nav.expand': '展开侧栏',

  'theme.label': '外观',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '跟随系统',

  'library.title': '资料库',
  'library.count': '{count} 个条目',
  'library.import': '导入文件',
  'library.importing': '正在导入…',
  'library.search': '搜索标题',
  'library.searchEmpty': '没有匹配「{query}」的条目',
  'library.clearSearch': '清除搜索',

  'library.empty.title': '还没有任何内容',
  'library.empty.body': '把 TXT、PDF 或音频文件拖进来，或者用下面的按钮选择文件。文件会被复制进资料库，之后即使原文件移动也不受影响。',
  'library.empty.action': '选择文件',
  'library.empty.hint': '支持 .txt .pdf .mp3 .m4a .flac .wav .ogg',

  'library.drag.title': '松开即可导入',
  'library.drag.body': '文件会被复制进资料库',

  'library.failed': '{count} 个文件导入失败',
  'library.failedMore': '查看详情',

  'entry.remove': '从资料库移除',
  'entry.removeConfirm': '移除「{title}」？',
  'entry.removeConfirmBody': '资料库中的副本会被删除，原始文件不受影响。',
  'entry.removeCancel': '取消',
  'entry.removeAction': '移除',
  'entry.progress': '已读 {percent}%',

  'export.menu': '更多操作',
  'export.action': '导出',
  'export.done': '已导出 {count} 个文件',
  'export.partial': '已导出 {written} 个，{skipped} 个跳过',
  'export.skippedMore': '查看原因',
  'export.selectMode': '选择要导出的条目',
  'export.selected': '已选 {count} / 共 {total}',
  'export.selectAll': '全选',
  'export.clearSelection': '清除',
  'export.cancel': '取消',
  'export.run': '导出',
  'export.running': '正在导出…',
  'export.converting': '正在转换 {done} / {total}',
  'export.noSelection': '还没有选择条目',
  'export.original': '原始文件',
  'export.text': '纯文本',

  'viewer.back': '返回资料库',
  'viewer.missing.title': '没有可以打开这种文件的查看器',
  'viewer.missing.body': '「.{ext}」格式目前没有注册查看器。如果是你自己定义的格式，可以在查看器注册表里登记一个。',
  'viewer.missing.noExt': '这个文件没有扩展名，无法判断格式。',
  'viewer.error.title': '打不开这个文件',

  'txt.encodingAuto': '自动（{encoding}）',
  'txt.lossy': '自动识别可能有误，若显示乱码请切换编码。',
  'txt.fontSmaller': '减小字号',
  'txt.fontLarger': '增大字号',
  'txt.toc': '目录',
  'txt.prevChapter': '上一章',
  'txt.nextChapter': '下一章',
  'txt.lastChapter': '已经是最后一章。',
  'txt.chapterPosition': '第 {index} / {total} 章',

  'pdf.page': '第 {page} / {total} 页',
  'pdf.prev': '上一页',
  'pdf.next': '下一页',
  'pdf.zoomIn': '放大',
  'pdf.zoomOut': '缩小',
  'pdf.fitWidth': '适合宽度',
  'pdf.loading': '正在打开 PDF…',
  'pdf.password.title': '这个 PDF 需要密码',
  'pdf.password.body': '输入密码后才能查看内容。',
  'pdf.password.placeholder': '密码',
  'pdf.password.submit': '解锁',
  'pdf.password.wrong': '密码不正确，请重试。',
  'pdf.error': 'PDF 无法解析，文件可能已损坏。',

  'audio.play': '播放',
  'audio.pause': '暂停',
  'audio.speed': '倍速',
  'audio.volume': '音量',
  'audio.position': '{current} / {duration}',
  'audio.unsupported': '这个音频文件无法播放。',

  'epub.loading': '正在打开 EPUB…',
  'epub.toc': '目录',
  'epub.tocEmpty': '这本书没有目录，可以用上一章 / 下一章翻阅。',
  'epub.prevChapter': '上一章',
  'epub.nextChapter': '下一章',
  'epub.finished': '已经读到最后一章。',
  'epub.mode': '渲染方式',
  'epub.modeOriginal': '原版',
  'epub.modeReflow': '重排',
  'epub.followTheme': '跟随主题',
  'epub.noContent': '这本书没有可读的正文内容。',
  'epub.badArchive': '无法解压这本书，文件可能已损坏。',
  'epub.tooLarge': '这本书有 {size} MB，超过了 {limit} MB 的上限。整本书需要读进内存，过大的文件会让应用卡死。',
  'epub.drm.title': '这本书受 DRM 保护',
  'epub.drm.body': '它被加密过，需要专门的阅读软件才能打开。litearti 不提供解密，也不会尝试绕过。',

  'source.title': '书源',
  'source.count': '{count} 个书源',
  'source.import': '导入书源',
  'source.importing': '正在导入…',
  'source.template': '书源模板',
  'source.templateBody': '把下面这份 JSON 保存成文件，改掉 id、name 和选择器，再导入。字段含义见 docs/book-sources.md。',
  'source.copyTemplate': '复制',
  'source.enabled': '启用',
  'source.remove': '删除',
  'source.networkNotice': '书源板块会联网：它只访问你添加的书源所指向的网站，不会上传任何本地数据。看板、资料库和本地阅读仍然完全离线。',
  'source.empty.title': '还没有书源',
  'source.empty.body': '书源是一份 JSON，描述怎么从一个网站取书。导入一份书源后，就能在这里搜索、阅读和下载。',
  'source.issues': '书源校验未通过，共 {count} 个问题',
  'source.backToSources': '返回书源',
  'source.backToBrowse': '返回搜索',
  'source.backToDetail': '返回目录',
  'source.pick': '选择书源',
  'source.search': '搜索',
  'source.searching': '搜索中…',
  'source.searchPlaceholder': '输入书名或关键词',
  'source.searchHint.title': '输入关键词开始搜索',
  'source.searchHint.body': '搜索会请求这个书源指向的网站，结果来自该网站。',
  'source.searchHintUrl': '也可以直接粘贴书籍目录页的网址，例如 https://www.bqg5555.cc/xs/250929/',
  'source.openSite': '访问网站',
  'source.login': '登录',
  'source.relogin': '重新登录',
  'source.logout': '退出登录',
  'source.loggingIn': '等待登录…',
  'source.loggedIn': '已登录 {host}',
  'source.loggedOut': '未登录',
  'source.loginSuccess': '登录成功，已保存 {count} 项 Cookie',
  'source.noResults': '没有找到结果',
  'source.noResultsBody': '「{keyword}」在这个书源里没有匹配项。换个关键词，或者换一个书源。',
  'source.type.novel': '小说',
  'source.type.comic': '漫画',
  'source.type.audio': '听书',
  'source.type.video': '视频',
  'source.chapterCount': '共 {count} 章',
  'source.chapters': '章节',
  'source.noChapters': '这个书源没有解析到章节，可能是详情页选择器不对。',
  'source.readOnline': '在线阅读',
  'source.download': '下载并导入',
  'source.downloadStarting': '准备中…',
  'source.downloading': '下载中 {done} / {total}',
  'source.downloadDoneJoined': '已导入资料库（拼接了 {count} 章）',
  'source.downloadDoneFile': '已导入资料库',
  'source.chapterPosition': '第 {index} / {total} 章',
  'source.prevChapter': '上一章',
  'source.nextChapter': '下一章',
  'source.lastChapter': '已经是最后一章。',
  'source.emptyChapter': '这一章没有正文',
  'source.emptyChapterBody': '选择器可能没匹配到内容，或者这一章本身是空的。',

  'common.cancel': '取消',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.loading': '载入中…',

  'dashboard.title': '看板',
  'dashboard.subtitle': '资料库概览',
  'dashboard.empty.title': '还没有数据',
  'dashboard.empty.body': '导入文件后，这里会显示格式分布、阅读状态和最近阅读。',
  'dashboard.empty.action': '去导入文件',

  'dashboard.total': '条目总数',
  'dashboard.storage': '占用空间',
  'dashboard.inProgress': '在读',
  'dashboard.thisWeek': '本周新增',

  'dashboard.formats': '格式分布',
  'dashboard.formats.empty': '暂无格式',
  'dashboard.states': '阅读状态',
  'dashboard.state.unread': '未开始',
  'dashboard.state.in-progress': '在读',
  'dashboard.state.finished': '已读完',
  'dashboard.recent': '最近阅读',
  'dashboard.recent.empty': '还没有打开过任何文件',
  'dashboard.unit.entry': '个',
  'dashboard.unit.file': '个文件',
} as const

export type MessageKey = keyof typeof zhCN

const dictionaries: Record<string, Record<string, string>> = {
  'zh-CN': zhCN,
}

let locale = 'zh-CN'

/** Translate a key, filling `{name}` placeholders from `params`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const table = dictionaries[locale] ?? zhCN
  const template = table[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Available locales, for a future language picker. */
export function availableLocales(): string[] {
  return Object.keys(dictionaries)
}

export function setLocale(next: string): void {
  if (dictionaries[next]) locale = next
}

export function currentLocale(): string {
  return locale
}

/** Expose `t` to templates without importing it in every component. */
export function useI18n() {
  return { t, locale: currentLocale, setLocale }
}