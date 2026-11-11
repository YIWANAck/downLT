const MiB = 1024 * 1024;
const MAX_ASSET = 24 * MiB;
export const MAX_EMBEDDED = 96 * MiB;

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
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_ASSET || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) return new Blob(chunks);
            length += value.length;
            if (length > MAX_ASSET) { await reader.cancel(); return null; }
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
    let limitReached = false;
    return {
        get embeddedBytes() { return embeddedBytes; },
        get limitReached() { return limitReached; },
        resetBudget() { embeddedBytes = 0; limitReached = false; },
        clearCache() { cache.clear(); },
        async embed(source, key) {
            signal?.throwIfAborted();
            const url = source instanceof Blob ? null : mediaUrl(source, base, external);
            if (!(source instanceof Blob) && !url) return null;
            if (url?.startsWith('data:') && url.length > MAX_ASSET * 1.4) return null;
            const cacheKey = url || key;
            let asset = cacheKey ? cache.get(cacheKey) : undefined;
            if (asset === undefined) {
                try {
                    const deadline = AbortSignal.timeout(12000);
                    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
                    const blob = url ? await boundedBlob(await fetch(url, {
                        credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
                    })) : source;
                    const mime = blob?.size && blob.size <= MAX_ASSET
                        ? sniffMedia(new Uint8Array(await blob.slice(0, 32).arrayBuffer())) : null;
                    asset = mime ? { mime, data: await toDataUrl(new Blob([blob], { type: mime })) } : null;
                } catch (error) {
                    if (signal?.aborted) throw error;
                    asset = null;
                }
                if (asset && asset.data.length + embeddedBytes > maxEmbedded) {
                    limitReached = true;
                    return null;
                }
                if (cacheKey) cache.set(cacheKey, asset);
            }
            signal?.throwIfAborted();
            if (!asset) return null;
            if (asset.data.length + embeddedBytes > maxEmbedded) { limitReached = true; return null; }
            embeddedBytes += asset.data.length;
            return asset;
        },
    };
}
