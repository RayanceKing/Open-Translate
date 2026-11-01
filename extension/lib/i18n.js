const EN = new Map([
  ['通用', 'General'], ['显示样式', 'Appearance'], ['视频字幕', 'Video subtitles'], ['漫画模式', 'Manga mode'],
  ['翻译服务', 'Translation services'], ['AI 翻译', 'AI translation'], ['术语库', 'Glossary'],
  ['隐私与安全', 'Privacy & security'], ['站点规则', 'Site rules'], ['关于', 'About'],
  ['设置', 'Settings'], ['恢复默认', 'Reset'], ['已保存', 'Saved'],
  ['翻译引擎', 'Translation engine'], ['目标语言', 'Target language'], ['源语言', 'Source language'],
  ['界面语言', 'Interface language'], ['界面语言设置影响控制面板的显示语言，和翻译的目标语言无关。', 'Controls the language of this settings panel and does not affect the translation target.'],
  ['译文使用的语言。', 'Language used for translations.'], ['自动检测', 'Auto detect'],
  ['打开页面自动翻译', 'Translate pages automatically'], ['显示页面悬浮按钮', 'Show floating button'],
  ['性能', 'Performance'], ['每批段落数', 'Paragraphs per batch'], ['并发请求数', 'Concurrent requests'],
  ['打开任意网页即可翻译文章、字幕和选中文本。', 'Open any webpage to translate articles, subtitles, and selected text.'],
  ['翻译此页', 'Translate this page'], ['还原原文', 'Restore original'], ['字幕', 'Subtitles'],
  ['打开设置', 'Open settings'], ['翻译', 'Translate'], ['还原', 'Restore'],
  ['使用', 'Use'], ['使用中', 'In use'], ['测试连接', 'Test connection'],
  ['双语对照', 'Bilingual'], ['仅译文', 'Translation only'], ['悬停显示', 'Show on hover'],
  ['双语字幕', 'Bilingual subtitles'], ['默认主题', 'Default theme'], ['跟随系统', 'Follow system'],
  ['浅色', 'Light'], ['深色', 'Dark'], ['系统翻译', 'System translation']
]);

export function applyInterfaceLanguage(language) {
  const english = language === 'en';
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue.trim();
    if (!value) continue;
    const translated = english ? EN.get(value) : [...EN].find(([, text]) => text === value)?.[0];
    if (translated) node.nodeValue = node.nodeValue.replace(value, translated);
  }
  document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(node => {
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const value = node.getAttribute(attribute);
      const translated = english ? EN.get(value) : [...EN].find(([, text]) => text === value)?.[0];
      if (translated) node.setAttribute(attribute, translated);
    }
  });
}
