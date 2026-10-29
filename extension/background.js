const mask = text => {
  const values = [];
  const put = value => `__OT_PRIVATE_${values.push(value) - 1}__`;
  const safe = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, put).replace(/\b(?:\+?\d[\s-]?){8,16}\b/g, put).replace(/\b(?:sk-[\w-]{16,}|ghp_[\w]{20,}|AKIA[\w]{16})\b/g, put);
  return { safe, restore: output => output.replace(/__\s*OT_PRIVATE\s*_(\d+)\s*__/gi, (_, i) => values[Number(i)] || _) };
};
async function translate(text, target) {
  const secured = mask(text);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(secured.safe)}`;
  const google = await fetch(url).then(async response => { if (!response.ok) throw new Error(`Google (${response.status})`); return response.json(); });
  return secured.restore(google[0].map(item => item[0]).join(''));
}
chrome.runtime.onMessage.addListener((message, _, respond) => {
  if (message.type !== 'translate') return;
  translate(message.text, message.target).catch(async () => {
    const secured = mask(message.text);
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(secured.safe.slice(0, 500))}&langpair=auto%7C${encodeURIComponent(message.target)}`;
    const response = await fetch(url); const result = await response.json();
    if (!response.ok || result.responseStatus !== 200) throw new Error(result.responseDetails || '翻译服务不可用');
    return secured.restore(result.responseData.translatedText);
  }).then(text => respond({ text })).catch(error => respond({ error: error.message })); return true;
});
chrome.commands?.onCommand.addListener(async command => { if (command === 'toggle-translation') { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); chrome.tabs.sendMessage(tab.id, { type: 'toggle' }); } });
