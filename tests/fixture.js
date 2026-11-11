import { md5 } from '/scripts/extensions/third-party/st-html-export/model.js';

const canvas = document.createElement('canvas');
canvas.width = 32;
canvas.height = 24;
const ctx = canvas.getContext('2d');
const png = color => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
};
const urlA = png('#9e2034');
const urlB = png('#1e527e');
const urlC = png('#6d922d');
const pngBytes = data => Uint8Array.from(atob(data.split(',')[1]), char => char.charCodeAt(0)).buffer;

const cachedMeta = {
    [md5('雨夜,站台')]: { index: 1, images: [{ uuid: 'dbA', date: 1 }, { uuid: 'dbB', date: 2 }] },
    [md5('metadata')]: { index: 0, images: [{ uuid: 'dbC', date: 1 }] },
    [md5('portrait <lora:example:0.7>')]: { index: 0, images: [{ uuid: 'dbC', date: 1 }] },
};
await new Promise((resolve, reject) => {
    const request = indexedDB.open('chatu8_gallery', 6);
    request.onupgradeneeded = () => request.result.createObjectStore('tupianhuancun', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('tupianhuancun', 'readwrite');
        const store = tx.objectStore('tupianhuancun');
        store.put({ id: 'tupianshuju', shuju: JSON.stringify(cachedMeta) });
        store.put({ id: 'dbA', data: pngBytes(urlA) });
        store.put({ id: 'dbB', data: pngBytes(urlB) });
        store.put({ id: 'dbC', data: pngBytes(urlC) });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
    };
});

const chat = Array.from({ length: 32 }, (_, i) => ({ name: '旅人', mes: `第 ${i + 1} 条消息` }));
chat[0].mes = '第一条，没出现在酒馆页面。';
chat[1].mes = '**前文** <think>原文思考\n第二行思考</think> image###雨夜，站台### 后文 <options>原文选项</options>';
chat[2].mes = '<p>她来到旧站台。</p><p>第二段。<em>回声</em></p>';
chat[2].swipe_id = 1;
chat[2].extra = { images: { 0: [{ tag: 'wrong' }], 1: [{ tag: 'server', regex: '旧站台。', endIndex: 1000 }] } };
chat[3].mes = '另一个故事';
chat[4].mes = '需要恢复 image###lost###；文字仍可读。';
chat[5].mes = '<p onclick="alert(1)">恶意标记测试 <a href="javascript:alert(1)">危险链接</a></p><script>alert(1)</script><img src="/api/settings/get" onerror="alert(1)"><img src="https://external.invalid/spy.png"><svg onload="alert(1)"><circle/></svg>';
chat[6].mes = '<p>普通图片附件</p>';
chat[6].is_user = true;
chat[6].extra = { media: [{ type: 'image', url: '/user/images/test.png' }] };
chat[7].mes = '<pre><code>image###code###</code></pre>';
chat[8].mes = '<p>一张无定位插图。</p>';
chat[8].extra = { images: { 0: [{ tag: 'metadata', regex: '找不到的文字' }] } };
chat[9].name = '<script>alert(1)</script>';
chat[10].mes = '<p>第一张 image###雨夜，站台### 第二张 image###metadata### 结尾</p>';
chat[11].mes = '<p>绘图 <image>image###portrait <lora:example:0.7>###</image> 完毕。</p>';
chat[31].mes = '原文，这条的渲染内容来自页面。';

const live = document.createElement('div');
live.className = 'mes';
live.setAttribute('mesid', '31');
const body = document.createElement('div');
body.className = 'mes_text';
const frame = document.createElement('iframe');
const frameLoaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
frame.srcdoc = '<p>嵌入状态栏</p><choices>页面选项</choices><button class="image-tag-button" data-request-id="live" data-link="live">生图按钮</button><span class="st-chatu8-image-span" data-request-id="live"></span>';
body.append(frame);
live.append(body);
document.getElementById('chat').append(live);
await frameLoaded;
const img = frame.contentDocument.createElement('img');
img.src = URL.createObjectURL(new Blob([pngBytes(urlA)], { type: 'image/png' }));
frame.contentDocument.querySelector('.st-chatu8-image-span').append(img);

const handlers = new Set();
const context = {
    chat, chatId: '雨夜档案 <测试>', characterId: 0, name2: '旅人',
    getCurrentChatId: () => context.chatId,
    chatMetadata: { 'st-chatu8': { data: { image_groups: { '另一个故事': [{ tag: 'metadata', endIndex: 5 }] } } } },
    extensionSettings: { 'st-chatu8': { startTag: 'image###', endTag: '###', jiuguanchucun: 'true', jiuguanStorage: { [md5('server')]: { index: 0, images: [{ uuid: 'serverA', path: 'user/images/test.png' }] } } }, private: 'SECRET_TEST_KEY' },
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
    eventSource: { on: (_, f) => handlers.add(f), removeListener: (_, f) => handlers.delete(f) },
    messageFormatting(raw) {
        // Minimal stand-in for the host's formatting API. The exporter must keep the HTML semantics.
        const html = raw.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        return html.startsWith('<') ? html : `<p>${html}</p>`;
    },
};
globalThis.SillyTavern = { getContext: () => context };
globalThis.testValues = { context, urlA, urlB, urlC, chatBefore: JSON.stringify(chat), changed: () => handlers.forEach(fn => fn()) };
await import('/scripts/extensions/third-party/st-html-export/index.js');
globalThis.fixtureReady = true;
