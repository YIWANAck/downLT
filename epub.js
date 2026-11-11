const MIME = 'application/epub+zip';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const BOOK_CSS = `
body { line-height: 1.65; }
.message { margin: 1em 0; padding: .65em 0; border-top: 1px solid #888; }
.speaker { font-weight: bold; }
.time { padding-left: .7em; font-size: .82em; }
.media { display: block; margin: .75em 0; }
.media img { max-width: 100%; height: auto; }
.media small { display: block; }
.media-missing, .note { font-size: .85em; }
pre { white-space: pre-wrap; word-wrap: break-word; }
td, th { padding: .25em; border: 1px solid #888; }
table { border-collapse: collapse; }
`;

export class EpubExportError extends Error {}

function xmlSafe(value) {
    return String(value).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '');
}

const xmlText = value => xmlSafe(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

function bookId() {
    // getRandomValues is available on ordinary HTTP installations as well.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function xhtml(title, body, css) {
    return `${XML}\n<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="${EPUB_NS}" xml:lang="zh-CN" lang="zh-CN">
<head><title>${xmlText(title)}</title><link rel="stylesheet" type="text/css" href="${css}" /></head>
<body>${xmlSafe(body)}</body></html>`;
}

async function getZipLibrary() {
    if (typeof globalThis.JSZip !== 'function') {
        try { await import('../../../../lib/jszip.min.js'); }
        catch { throw new EpubExportError('当前酒馆未能加载 EPUB 打包组件。请检查酒馆版本或改用 HTML 导出。'); }
    }
    if (typeof globalThis.JSZip !== 'function') throw new EpubExportError('EPUB 打包组件不可用。');
    return globalThis.JSZip;
}

export async function buildEpub({ title, articles, images, chapterSize, notes, timestamp, signal, onPack }) {
    if (!Number.isSafeInteger(chapterSize) || chapterSize < 1) throw new EpubExportError('每章消息数必须是正整数。');
    const JSZip = await getZipLibrary();
    signal?.throwIfAborted();
    const zip = new JSZip();
    zip.file('mimetype', MIME, { compression: 'STORE', createFolders: false });
    const addText = (path, content) => zip.file(path, content, { compression: 'DEFLATE', createFolders: false });
    addText('META-INF/container.xml', `${XML}\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" /></rootfiles></container>`);
    addText('EPUB/book.css', BOOK_CSS);

    const chapters = [];
    for (let offset = 0; offset < articles.length; offset += chapterSize) {
        const number = chapters.length + 1;
        const id = `chapter-${number}`;
        const label = `第 ${number} 章`;
        const path = `chapters/${id}.xhtml`;
        const note = number === 1 && notes ? `<p class="note">${xmlText(notes)}</p>` : '';
        const body = articles.slice(offset, offset + chapterSize).join('\n');
        addText(`EPUB/${path}`, xhtml(label, `<h1>${label}</h1>${note}${body}`, '../book.css'));
        chapters.push({ id, label, path });
    }

    const toc = chapters.map(({ path, label }) => `<li><a href="${path}">${label}</a></li>`).join('');
    addText('EPUB/nav.xhtml', xhtml('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${toc}</ol></nav>`, 'book.css'));

    const mediaItems = [];
    for (const [name, { blob, mime }] of images) {
        const path = `images/${name}`;
        zip.file(`EPUB/${path}`, blob, { compression: 'STORE', createFolders: false });
        mediaItems.push(`<item id="image-${mediaItems.length + 1}" href="${path}" media-type="${mime}" />`);
    }
    const chapterItems = chapters.map(({ id, path }) => `<item id="${id}" href="${path}" media-type="application/xhtml+xml" />`).join('');
    const spine = chapters.map(({ id }) => `<itemref idref="${id}" />`).join('');
    const modified = timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z');
    addText('EPUB/package.opf', `${XML}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${bookId()}</dc:identifier><dc:title>${xmlText(title)}</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">${modified}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" /><item id="css" href="book.css" media-type="text/css" />${chapterItems}${mediaItems.join('')}</manifest>
<spine>${spine}</spine></package>`);

    signal?.throwIfAborted();
    const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'STORE' });
    return new Promise((resolve, reject) => {
        const chunks = [];
        let shownPercent = -1;
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const abort = () => {
            stream.pause();
            chunks.length = 0;
            cleanup();
            reject(signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
        stream.on('data', (chunk, { percent }) => {
            if (signal?.aborted) return;
            chunks.push(chunk);
            const rounded = Math.floor(percent);
            if (rounded !== shownPercent) { shownPercent = rounded; onPack?.(rounded); }
        });
        stream.on('error', error => { cleanup(); reject(error); });
        stream.on('end', () => { cleanup(); resolve(new Blob(chunks, { type: MIME })); });
        stream.resume();
    });
}
