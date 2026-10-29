# Open Translate

一个轻量的网页双语翻译工具，同时提供 **Tampermonkey 用户脚本** 和 **Manifest V3 浏览器扩展** 两种形态。它只处理文章与主内容中的可读文本块，在原文后就地插入译文，不会把整页导航、按钮和代码块一起翻掉。

设计思路参考 Immersive Translate（按段落双语对照、多引擎切换、样式预设）与 OpenImmersive Translator（直连引擎、隐私优先）。代码为独立实现，未复制其源码。

## 快速开始

### 方式一：Tampermonkey（推荐，Safari 亦可）

1. 在浏览器安装并启用 Tampermonkey，授予其访问目标站点的权限。
2. 新建脚本，把 [`tampermonkey/open-translate.user.js`](tampermonkey/open-translate.user.js) 全部内容粘贴保存。
3. 打开任意文章页，按 <kbd>Alt</kbd> + <kbd>T</kbd>，或点击屏幕边缘的悬浮球。
4. 悬浮球可拖动，松手会自动吸附到最近的左右边缘并记住位置；上方的齿轮按钮随时打开设置。
5. 点齿轮打开设置面板，可切换引擎、填写 API Key、调整译文样式。

> Safari 的原生扩展不能直接加载 `.user.js`，Tampermonkey 是最省事的安装方式。

### 方式二：浏览器扩展（Chrome / Edge / Safari App Extension）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 选择「加载已解压的扩展程序」，指向仓库中的 [`extension/`](extension/) 目录。
3. 点击工具栏图标打开快捷面板，或右键图标 →「选项」进入完整设置页。

Safari 14+ 可用 Xcode 的 **Safari Web Extension Converter** 导入 `extension/` 目录后签名运行。打包时请确认「Website Access」允许目标站点。

## 功能

### 翻译引擎

设置页可在 9 个引擎之间随时切换，密钥按引擎独立保存：

| 引擎 | 密钥 | 说明 |
| --- | --- | --- |
| Google 翻译 | 否 | 公共 gtx 端点，速度快，高频调用可能被限流 |
| MyMemory | 否 | 公益翻译记忆库，单次 500 字符，适合兜底 |
| DeepL | 是 | 质量优秀，支持 Free / Pro 两套端点 |
| Microsoft 翻译 | 可选 | 默认走 Bing 翻译页使用的公开通道，无需密钥；遇到限流或需要更高配额时，可打开「使用 Azure 密钥」改用自己的 Azure 订阅（支持批量与区域选择） |
| LibreTranslate | 自建 | 开源可自部署，数据不出自己的服务器 |
| OpenAI | 是 | 也兼容 one-api、OpenRouter、本地 Ollama 等网关 |
| DeepSeek | 是 | 国内直连友好、价格低 |
| Google Gemini | 是 | 免费额度较高，长上下文友好 |
| Claude | 是 | 已自动附加浏览器直连所需请求头 |

每个引擎卡片都有「测试连接」按钮，会用一句英文实时验证 Key 与网络是否可用。

Microsoft 的免费通道复刻了 Bing 翻译页自身的调用方式：先取一次 `bing.com/translator` 页面，从中解析出 `IG`、`IID` 与 `params_AbusePreventionHelper`（key + token），再把这些凭证带到 `/ttranslatev3`。凭证缓存 8 分钟，过期时（HTTP 401/403）自动刷新并重试一次。该端点由微软公开提供但不受正式 SLA 保证，若返回无法识别的页面或持续限流，请改用 Azure 密钥。

### 显示模式

- **双语对照**：原文在上，译文紧随其后（默认）。
- **仅译文**：隐藏原文只显示译文，适合快速浏览。
- **悬停显示**：译文默认隐藏，鼠标移到原文上才浮现。

### 译文样式

8 种预设：无样式、虚线下划线、左侧竖线、卡片、引用块、高亮、淡色、模糊。选中后还可在设置页微调字号、行高、字重、不透明度、文字颜色、主题色、背景色、圆角、内边距与段落间距，右侧有实时预览。

### AI 翻译

- 可自定义提示词模板，支持 `{{target}}`、`{{source}}` 变量
- 术语表：每行 `原文 = 译文`，强制模型照此翻译
- 温度可调，长段落自动按编号批量发送，解析失败会自动降级为逐段请求

### 其他

- 打开页面自动翻译，支持按域名设置「总是翻译」与「排除列表」
- 悬浮球可拖动并自动吸附左右边缘，位置随配置保存；齿轮按钮悬浮在球的上方，一键进入设置
- `Alt + T` 翻译/还原，`Alt + Shift + T` 翻译选中文本（弹出气泡，不再是 alert）
- 右键菜单「翻译选中文本」（扩展）
- 设置页支持浅色/深色/跟随系统，可导出、导入 JSON 配置；脚本版面板底部同样提供「恢复默认 / 导出 / 导入」三个按钮
- 译文带会话级缓存，见下节

### 翻译缓存

翻译结果按「引擎 + 目标语言 + 源语言 + 提示词指纹 + 段落指纹」缓存，命中时不再发起任何网络请求。

- **作用范围**：扩展写在 `chrome.storage.session`（内存，不落盘），脚本写在 `sessionStorage`。刷新页面、切换标签页、后台 service worker 被系统回收后重新唤醒，都能直接命中；关闭浏览器或关闭标签页即清空。
- **有效期**：条目最多保留 12 小时，最多 2000 条，超出按写入顺序淘汰。
- **只存译文**：key 是 64 位指纹，原文不会进入缓存，即使有人翻看存储也读不到你读过什么。
- **会自动失效**：换引擎、换语言、改 AI 提示词或术语表都会得到不同的 key，不会误用旧译文。
- **手动清空**：设置页「隐私与安全 → 翻译缓存」显示当前条数并提供「清空缓存」；脚本面板在「通用 → 翻译缓存」里同样可以清空。

## 隐私

- 翻译请求由浏览器直接发往所选引擎，没有中转服务器，也没有任何统计数据上报。
- 使用 Microsoft 免费通道时会先访问一次 `bing.com/translator` 读取公开凭证，这是该端点唯一的前置请求，不会上传任何待翻译内容。
- 默认开启「屏蔽敏感信息」：邮箱、疑似电话号码、常见 API Token 在离开浏览器前被替换为占位符，译文返回后还原。
- 所有设置与密钥保存在浏览器本地（扩展为 `chrome.storage.local`，脚本为 GM 存储），仅本机可读。
- 翻译缓存只保存译文与指纹，不保存原文，且不写入磁盘（`chrome.storage.session` / `sessionStorage`），关闭浏览器即消失。

## 项目结构

```
extension/
  manifest.json         MV3 清单
  background.js         service worker：引擎调度、缓存、脱敏
  content.js            页面扫描、批量队列、译文渲染
  content.css           译文样式与悬浮控件
  options.html/.css/.js 完整设置页
  popup.html/.css/.js   快捷面板
  lib/defaults.js       设置模型、语言表、样式预设
  lib/engines.js        各引擎实现（统一 translate(texts) 接口）
  lib/catalog.js        引擎元数据（供设置页渲染）
  lib/privacy.js        敏感信息脱敏
  lib/cache.js          会话级译文缓存（内存 + chrome.storage.session）
  lib/store.js          设置读写与旧版本迁移
tampermonkey/
  open-translate.user.js  单文件用户脚本（内含同款设置面板）
```

零依赖、原生 JavaScript。修改后重新加载扩展或脚本即可生效。

## 已知限制

- 公共 Google 端点没有服务等级保证，部分网络环境可能无法访问。
- 不翻译输入框、代码块、预格式化文本和自身生成的内容；复杂站点可在 `SITE_RULES` 中补充选择器。
- 「仅译文」模式会临时替换段落 DOM，遇到极端动态页面还原后可能有轻微样式差异。
- 生产发行建议把 `background.js` 中的公共端点替换为自建 LibreTranslate 或带密钥的正式服务。

## 许可

[AGPL](LICENSE)
