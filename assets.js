const MiB = 1024 * 1024;
const MAX_ASSET = 24 * MiB;
export const MAX_EMBEDDED = 96 * MiB;
export const MAX_BOOK_MEDIA = 128 * MiB;

export const MEDIA_FAILURES = {
    cache: '找不到生图缓存',
    external: '未开启外链图片导出',
    source: '媒体地址不受支持',
    unavailable: '源文件已不存在或无法读取',
    timeout: '读取媒体超时',
    format: '文件为空或格式不受支持',
    oversized: '单个文件超过 24 MiB',
    budget: '超出本文件的内嵌容量',
    bookVideo: 'EPUB 版仅保存图片，视频可用 HTML 导出',
    dimensions: '图片像素过大，无法转成 EPUB 插图',
};

export const EPUB_IMAGE_EXTENSIONS = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

export function describeMediaFailures(failures) {
    return Object.entries(failures).map(([reason, count]) => `${MEDIA_FAILURES[reason]}（${count} 项）`).join('、');
}

export function mediaUrl(source, base, external = false) {
    if (typeof source !== 'string' || !source.trim()) return null;
    if (/^data:(?:image\/(?:png|jpe?g|webp|gif|bmp|avif)|video\/(?:mp4|webm));base64,[a-z0-9+/=\s]+$/i.test(source)) return source;
    try {
        const here = new URL(base);
        const url = new URL(source, here);
        if (url.username || url.password) return null;
        if (url.protocol === 'blob:') return url.origin === here.origin ? url.href : null;
        if (url.origin === here.origin) {
            const pathname = decodeURIComponent(url.pathname);
            // Only media routes, never arbitrary authenticated API/file requests.
            const mediaRoots = ['user/images/', 'user/files/', 'images/'].map(path => new URL(path, here).pathname);
            if (mediaRoots.some(root => pathname.startsWith(root)) && !/(?:^|\/)\.\.(?:\/|$)|[\\\0]/.test(pathname)) return url.href;
            return null;
        }
        return external && url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
}

export function sniffMedia(bytes) {
    const at = (offset, ...values) => values.every((value, i) => bytes[offset + i] === value);
    const ascii = (offset, value) => at(offset, ...Array.from(value, char => char.charCodeAt(0)));
    if (at(0, 137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
    if (at(0, 255, 216, 255)) return 'image/jpeg';
    if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
    if (ascii(0, 'BM')) return 'image/bmp';
    if (ascii(4, 'ftyp')) return ascii(8, 'avif') || ascii(8, 'avis') ? 'image/avif' : 'video/mp4';
    if (at(0, 26, 69, 223, 163)) return 'video/webm';
    return null;
}

async function boundedBlob(response) {
    if (!response.ok || !response.body) return { reason: 'unavailable' };
    if (Number(response.headers.get('content-length')) > MAX_ASSET) {
        await response.body.cancel();
        return { reason: 'oversized' };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) return { blob: new Blob(chunks) };
            length += value.length;
            if (length > MAX_ASSET) { await reader.cancel(); return { reason: 'oversized' }; }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
}

function toDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function epubImage(blob, mime) {
    if (mime.startsWith('video/')) return { reason: 'bookVideo' };
    if (EPUB_IMAGE_EXTENSIONS[mime]) return { asset: { mime, blob } };
    let bitmap;
    try {
        bitmap = await createImageBitmap(new Blob([blob], { type: mime }));
        if (bitmap.width * bitmap.height > 16_777_216) return { reason: 'dimensions' };
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!png) return { reason: 'format' };
        if (png.size > MAX_ASSET) return { reason: 'oversized' };
        return { asset: { mime: 'image/png', blob: png } };
    } catch { return { reason: 'format' }; }
    finally { bitmap?.close(); }
}

export function createAssetLoader({ base = location.href, external = false, signal, maxEmbedded = MAX_EMBEDDED, binary = false } = {}) {
    const cache = new Map();
    let embeddedBytes = 0;
    let counted = new WeakSet();

    async function load(source, url) {
        const deadline = AbortSignal.timeout(12000);
        try {
            const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
            const result = url ? await boundedBlob(await fetch(url, {
                credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
            })) : { blob: source };
            if (result.reason) return result;
            const { blob } = result;
            if (blob.size > MAX_ASSET) return { reason: 'oversized' };
            const mime = sniffMedia(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
            if (!mime) return { reason: 'format' };
            if (binary) return epubImage(blob, mime);
            const data = await toDataUrl(new Blob([blob], { type: mime }));
            return { asset: { mime, data } };
        } catch (error) {
            if (signal?.aborted) throw error;
            return { reason: deadline.aborted ? 'timeout' : 'unavailable' };
        }
    }

    return {
        get embeddedBytes() { return embeddedBytes; },
        resetBudget() { embeddedBytes = 0; counted = new WeakSet(); },
        clearCache() { cache.clear(); },
        async embed(source, key) {
            signal?.throwIfAborted();
            const url = source instanceof Blob ? null : mediaUrl(source, base, external);
            if (!(source instanceof Blob) && !url) {
                return { reason: !external && mediaUrl(source, base, true) ? 'external' : 'source' };
            }
            if (url?.startsWith('data:') && url.length > MAX_ASSET * 1.4) return { reason: 'oversized' };
            const cacheKey = url || key;
            const result = (cacheKey && cache.get(cacheKey)) || await load(source, url);
            signal?.throwIfAborted();
            const { asset } = result;
            const bytes = binary ? (asset && !counted.has(asset) ? asset.blob.size : 0) : (asset?.data.length ?? 0);
            if (embeddedBytes + bytes > maxEmbedded) return { reason: 'budget' };
            if (cacheKey) cache.set(cacheKey, result);
            if (binary && asset) counted.add(asset);
            embeddedBytes += bytes;
            return result;
        },
    };
}
