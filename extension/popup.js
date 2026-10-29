const language = document.querySelector('#language');
chrome.storage.local.get({ targetLanguage: 'zh-CN' }, ({ targetLanguage }) => language.value = targetLanguage);
async function page(message) { const [tab] = await chrome.tabs.query({ active:true, currentWindow:true }); return chrome.tabs.sendMessage(tab.id, message); }
document.querySelector('#translate').onclick = async () => { const targetLanguage = language.value.trim() || 'zh-CN'; await chrome.storage.local.set({ targetLanguage }); await page({ type:'translate', target: targetLanguage }); window.close(); };
document.querySelector('#restore').onclick = async () => { await page({ type:'restore' }); window.close(); };
