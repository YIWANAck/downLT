const MiB = 1024 * 1024;
const MAX_ASSET = 24 * MiB;
export const MAX_EMBEDDED = 96 * MiB;

export const MEDIA_FAILURES = {
    cache: '找不到生图缓存',
    external: '未开启外链图片导出',
    source: '媒体地址不受支持',
    unavailable: '源文件已不存在或无法读取',
    timeout: '读取媒体超时',
    format: '文件为空或格式不受支持',
    oversized: '单个文件超过 24 MiB',
    budget: '超出本文件的内嵌容量',
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

export function createAssetLoader({ base = location.href, external = false, signal, maxEmbedded = MAX_EMBEDDED } = {}) {
    const cache = new Map();
    let embeddedBytes = 0;

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
            const data = await toDataUrl(new Blob([blob], { type: mime }));
            return { asset: { mime, data } };
        } catch (error) {
            if (signal?.aborted) throw error;
            return { reason: deadline.aborted ? 'timeout' : 'unavailable' };
        }
    }

    return {
        get embeddedBytes() { return embeddedBytes; },
        resetBudget() { embeddedBytes = 0; },
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
            if (result.asset && result.asset.data.length + embeddedBytes > maxEmbedded) return { reason: 'budget' };
            if (cacheKey) cache.set(cacheKey, result);
            embeddedBytes += result.asset?.data.length ?? 0;
            return result;
        },
    };
}
