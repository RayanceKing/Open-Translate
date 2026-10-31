// UI metadata for every translation engine. Kept free of network code so the
// options page can import it without pulling in the provider implementations.

export const ENGINE_CATALOG = [
  {
    id: 'google',
    name: 'Google 翻译',
    tag: '免费',
    note: '公共 gtx 端点，无需密钥，速度快；高频调用可能被限流。',
    fields: []
  },
  {
    id: 'mymemory',
    name: 'MyMemory',
    tag: '免费',
    note: '公益翻译记忆库，单次最多 500 字符，适合作为备用引擎。',
    fields: []
  },
  {
    id: 'deepl',
    name: 'DeepL',
    tag: '需密钥',
    note: '译文质量优秀，支持术语表。免费额度需在 DeepL 后台申请 API Key。',
    fields: [
      { key: 'key', label: 'API Key', type: 'password', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx' },
      { key: 'pro', label: '使用 Pro 端点', type: 'switch', hint: '付费账号改为 api.deepl.com' }
    ]
  },
  {
    id: 'microsoft',
    name: 'Microsoft 翻译',
    tag: '免费',
    note: '默认走 Bing 翻译页使用的公开通道，无需密钥即可使用。遇到限流或需要更高配额时，可开启下方开关改用你自己的 Azure 订阅。',
    fields: [
      { key: 'useKey', label: '使用 Azure 密钥', type: 'switch', hint: '关闭时使用免费通道' },
      { key: 'key', label: '订阅密钥', type: 'password', placeholder: 'Azure Translator Key', dependsOn: 'useKey' },
      { key: 'region', label: '区域', type: 'text', placeholder: 'global / eastasia', dependsOn: 'useKey' }
    ]
  },
  {
    id: 'libre',
    name: 'LibreTranslate',
    tag: '自建',
    note: '开源可自部署，数据完全不出你的服务器。填写实例地址即可。',
    fields: [
      { key: 'url', label: '实例地址', type: 'text', placeholder: 'https://libretranslate.example.com' },
      { key: 'key', label: 'API Key（可选）', type: 'password', placeholder: '留空表示实例未开启鉴权' }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    tag: 'AI',
    note: '也可填任何 OpenAI 兼容网关地址（如 one-api、OpenRouter、本地 Ollama）。',
    fields: [
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tag: 'AI',
    note: '国内直连友好，价格低，长段落表现稳定。',
    fields: [
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'deepseek-chat' }
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    tag: 'AI',
    note: '免费额度较高，长文本上下文友好。',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'AIza...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gemini-2.0-flash' }
    ]
  },
  {
    id: 'claude',
    name: 'Claude',
    tag: 'AI',
    note: '语言自然度好；浏览器直连需要 Anthropic 允许，扩展会自动附加对应请求头。',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-ant-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'claude-3-5-haiku-latest' }
    ]
  },
  {
    id: 'custom',
    name: '自定义接口',
    tag: '自定义',
    note: '兼容 OpenAI Chat Completions 格式的第三方或本地翻译接口。',
    fields: [
      { key: 'name', label: '服务名称', type: 'text', placeholder: '我的翻译服务' },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://example.com/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: '可留空' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-4o-mini' }
    ]
  }
];

export const ENGINE_BY_ID = Object.fromEntries(ENGINE_CATALOG.map(engine => [engine.id, engine]));

export function engineName(id) {
  return ENGINE_BY_ID[id]?.name || id;
}
