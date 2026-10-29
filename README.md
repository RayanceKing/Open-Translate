# Open Translate

一个以 **Tampermonkey（含 Safari）优先** 的网页双语翻译工具。它只处理文章和主内容中的可读文本块，在原文后就地插入译文；不会把整页 UI、导航和代码块都翻掉。

灵感来自 Immersive Translate 的“按段落双语对照”和 OpenImmersive Translator 的“直连翻译引擎、隐私优先”理念。本项目是独立实现，未复制其代码。

## 快速开始（推荐：Safari + Tampermonkey）

1. 在 Safari 安装并启用 Tampermonkey，授予它访问目标网站的权限。
2. 新建脚本，将 [`tampermonkey/open-translate.user.js`](tampermonkey/open-translate.user.js) 的全部内容粘贴保存。
3. 打开任意文章页，点击右下角 `译` 按钮，或按 <kbd>⌥ Option</kbd> + <kbd>T</kbd>。

默认将页面翻译为简体中文。单击浮窗中的语言代码可输入目标语言（例如 `ja`、`en`、`fr`）；`还原` 会删除已插入的所有译文。

> Safari 的原生网页扩展不能直接加载 `.user.js`；Tampermonkey 是最简单、兼容性最好的安装方式。下面提供的 Web Extension 源码适合希望将其打包为 Safari App Extension 的开发者。

## 功能

- 原文/译文逐块上下排列，尽量保留原页面排版
- 自动识别 `article`、`main`、`[role=main]` 等主内容，内置 GitHub、Reddit、Hacker News 规则
- MutationObserver 支持无限滚动和 SPA 新出现的正文
- `Option + T` 翻译/还原，`Option + Shift + T` 只翻译当前选择
- 请求直连 Google 翻译公共端点，并在其限流时回退到 MyMemory；脚本版通过 Tampermonkey 的跨域请求避免 CORS
- 本地掩盖邮箱、疑似电话号码和常见 API token，翻译返回后恢复；默认开启
- 无遥测、无中转服务、无密钥上传；设置保存在浏览器本地

## 浏览器扩展（Safari 优先）

[`extension/`](extension/) 是 Manifest V3 源码：content script 负责页面双语渲染，background service worker 负责跨域翻译，popup 负责翻译、还原和语言选择。Safari 14+ 可用 Xcode 的 **Safari Web Extension Converter** 导入该目录并签名运行；Chrome/Edge 亦可在开发者模式加载该目录。

Safari 打包时请确认生成项目的“Website Access”允许目标站点，且网络权限保留两个翻译 API 的域名。生产发行建议将 `background.js` 中的公共端点替换为你自己的 LibreTranslate 或有密钥的翻译提供商。

## 开发与限制

这是一个零依赖的原生 JavaScript 项目：直接编辑脚本或扩展目录后即可重新加载测试。公共 Google 端点没有服务等级保证，也可能在部分网络环境受限。脚本不会翻译输入框、代码、预格式化文本和它自身生成的内容；复杂站点可在 `SITE_RULES` 增加选择器。

项目采用 [MIT](LICENSE) 许可。
