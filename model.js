const md5Shifts = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
const md5Constants = Array.from({ length: 64 }, (_, i) => Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))) >>> 0);

// MD5 is a cache-key format here, not a security mechanism. Web Crypto lacks it.
export function md5(text) {
    const bytes = new TextEncoder().encode(text);
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes);
    padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setBigUint64(padded.length - 8, BigInt(bytes.length) * 8n, true);
    const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < padded.length; offset += 64) {
        let [a, b, c, d] = state;
        for (let i = 0; i < 64; i++) {
            const round = i >>> 4;
            let f, g;
            if (round === 0) { f = (b & c) | (~b & d); g = i; }
            else if (round === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (round === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            const sum = (a + f + md5Constants[i] + view.getUint32(offset + g * 4, true)) | 0;
            const shift = md5Shifts[round * 4 + (i % 4)];
            [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0, b, c];
        }
        [a, b, c, d].forEach((word, i) => { state[i] = (state[i] + word) | 0; });
    }
    return state.map(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

export function normalizeTag(tag, substitute = value => value) {
    if (typeof tag !== 'string') return '';
    return substitute(tag).trim().replace(/[\r\n]/g, '').replaceAll('《', '<').replaceAll('》', '>')
        .replaceAll('，', ',').replaceAll('；', ';').replaceAll('：', ':');
}

export function selectImage(server, db, preferServer) {
    const files = (entry, source) => (Array.isArray(entry?.images) ? entry.images : [])
        .filter(image => image && typeof image === 'object').map(image => ({ ...image, source }));
    const fromServer = files(server, 'server');
    const fromDb = files(db, 'db');
    const sorted = [...fromServer, ...fromDb].sort((a, b) => (a.date || 0) - (b.date || 0));
    if (!sorted.length) return null;
    let index = fromServer.length ? server.index : db.index;
    if (fromDb.length && (!preferServer || !Number.isInteger(index)) && Number.isInteger(db.index)) index = db.index;
    return sorted[Math.min(sorted.length - 1, Number.isInteger(index) && index >= 0 ? index : 0)];
}

export function splitTags(text, start, end) {
    if (!start || !end) return [];
    const matches = [];
    for (let cursor = 0; cursor < text.length;) {
        const from = text.indexOf(start, cursor);
        if (from < 0) break;
        const stop = text.indexOf(end, from + start.length);
        if (stop < 0) break;
        const tag = text.slice(from + start.length, stop).trim();
        cursor = stop + end.length;
        if (tag && !(start === '[' && end === ']' && (text[from - 1] === '!' || text[cursor] === '(' || text[cursor] === '['))) {
            matches.push({ start: from, end: cursor, tag });
        }
    }
    return matches;
}

export function getPlacements(message, imageGroups, text) {
    const images = message.extra?.images;
    if (Array.isArray(images) && images.some(item => typeof item?.tag === 'string')) return images;
    const selected = images?.[message.swipe_id ?? 0];
    if (Array.isArray(selected) && selected.length) return selected;
    const start = Math.max(0, Math.floor(text.length / 2) - 10);
    const key = text.slice(start, start + 20);
    const saved = key && Object.hasOwn(imageGroups, key) ? imageGroups[key] : null;
    return Array.isArray(saved) ? saved : [];
}

export function nativeMedia(extra) {
    const attachments = Array.isArray(extra.media) ? extra.media : [];
    const selected = extra.media_display === 'gallery' && attachments.length
        ? [attachments[extra.media_index] ?? attachments[0]] : attachments;
    const urls = selected.filter(item => item?.type === 'image' || item?.type === 'video')
        .map(({ url, type }) => ({ url, type }));
    if (!attachments.length) {
        const image = extra.image || extra.image_swipes?.[extra.media_index ?? 0];
        if (image) urls.push({ url: image, type: 'image' });
        if (extra.video) urls.push({ url: extra.video, type: 'video' });
    }
    return urls.filter(item => typeof item.url === 'string' && item.url);
}

export function snapshotChat(context, { includeUser = true } = {}) {
    const title = String(context.getCurrentChatId?.() || context.chatId || context.name2 || '聊天记录');
    const groups = context.chatMetadata?.['st-chatu8']?.data?.image_groups;
    const messages = [];
    for (const [index, message] of context.chat.entries()) {
        if (!includeUser && message.is_user) continue;
        const extra = message.extra || {};
        messages.push({
            index,
            name: String(message.name || (message.is_user ? context.name1 || '我' : context.name2 || '角色')),
            date: String(message.send_date ?? ''),
            mes: String(extra.display_text ?? message.mes ?? ''),
            is_user: Boolean(message.is_user),
            is_system: Boolean(message.is_system),
            swipe_id: message.swipe_id ?? 0,
            extra: { images: extra.images ? structuredClone(extra.images) : undefined },
            attachments: nativeMedia(extra),
        });
    }
    return { title, messages, imageGroups: groups ? structuredClone(groups) : {} };
}
