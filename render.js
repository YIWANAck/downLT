import { getPlacements, splitTags } from './model.js';

const TAG = 'data-sthe-tag';
const BUTTONS = 'button.image-tag-button,button.st-chatu8-image-button';
const SLOT = '.st-chatu8-image-span';
const SANITIZE = {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ('p div span section article h1 h2 h3 h4 h5 h6 br hr em i strong b q blockquote ul ol li dl dt dd table tr td th thead tbody tfoot caption pre code a img video source details summary figure figcaption s del sup sub mark kbd small ruby rt rp').split(' '),
    ALLOWED_ATTR: ['src', 'alt', 'href', 'title', 'rowspan', 'colspan', 'start', 'open', 'class', TAG],
    // Blob URLs are used by the live chatu8 renderer. Asset loading subsequently checks origin and media bytes.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
};

function cloneRendered(source, inertDocument, depth = 0) {
    const copy = inertDocument.importNode(source, true);
    const originals = source.querySelectorAll('iframe');
    copy.querySelectorAll('iframe').forEach((frame, index) => {
        const replacement = copy.ownerDocument.createElement('section');
        replacement.className = 'embedded';
        let body;
        try { body = originals[index].contentDocument?.body; } catch { /* cross-origin */ }
        if (body && depth < 3) replacement.append(...cloneRendered(body, inertDocument, depth + 1).childNodes);
        else replacement.textContent = '此处有无法读取的嵌入内容。';
        frame.replaceWith(replacement);
    });
    const spans = new Map([...copy.querySelectorAll(SLOT)].map(span => [span.dataset.requestId, span]));
    for (const button of copy.querySelectorAll(BUTTONS)) {
        const prompt = button.dataset.link || button.dataset.imageTag;
        if (prompt) {
            let span = spans.get(button.dataset.requestId) || button.nextElementSibling?.closest(SLOT);
            if (!span) {
                span = copy.ownerDocument.createElement('span');
                button.after(span);
            }
            span.setAttribute(TAG, prompt);
        }
        button.remove();
    }
    copy.querySelectorAll('button, .st-chatu8-mini-player-controls, .st-chatu8-collapse-header, .st-chatu8-video-top-overlay, .st-chatu8-video-bottom-overlay, .st-chatu8-video-notice').forEach(node => node.remove());
    return copy;
}

export function captureRenderedMessages(chatElement) {
    const rendered = new Map();
    const inertDocument = document.implementation.createHTMLDocument('');
    for (const node of chatElement?.querySelectorAll(':scope > .mes[mesid]') || []) {
        const index = Number(node.getAttribute('mesid'));
        const content = node.querySelector('.mes_text');
        if (Number.isInteger(index) && content?.childNodes.length) rendered.set(index, cloneRendered(content, inertDocument).innerHTML);
    }
    return rendered;
}

function textPositions(root) {
    const doc = root.ownerDocument;
    const nodes = [];
    let text = '';
    const walker = doc.createTreeWalker(root, 5, { // SHOW_ELEMENT | SHOW_TEXT
        acceptNode(node) {
            if (node.nodeType === 3) return 1; // FILTER_ACCEPT
            if (node.hasAttribute(TAG) || node.classList.contains('media')) return 2; // FILTER_REJECT subtree
            return node.localName === 'br' ? 1 : 3; // FILTER_SKIP container
        },
    });
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = node.nodeType === 3 ? node.data : '\n';
        if (!value.length) continue;
        nodes.push({ node, start: text.length, end: text.length + value.length });
        text += value;
    }
    return { nodes, text };
}

function rangePoint(nodes, offset, isStart) {
    const info = nodes.find(({ start, end }) => isStart ? start <= offset && offset < end : start < offset && offset <= end);
    if (!info) return null;
    if (info.node.nodeType === 3) return [info.node, offset - info.start];
    const parent = info.node.parentNode;
    return [parent, Array.prototype.indexOf.call(parent.childNodes, info.node) + (offset > info.start ? 1 : 0)];
}

function insertAt(root, position, replacement, start = position) {
    const { nodes } = textPositions(root);
    const left = rangePoint(nodes, start, start !== position);
    const right = rangePoint(nodes, position, false);
    if (!left || !right) { root.append(replacement); return; }
    const range = root.ownerDocument.createRange();
    range.setStart(...left);
    range.setEnd(...right);
    range.deleteContents();
    range.insertNode(replacement);
}

function positionFor(text, placement) {
    const end = Number(placement.endIndex);
    const anchor = typeof placement.regex === 'string' ? placement.regex.trim() : '';
    if (Number.isInteger(end) && end > 0 && end <= text.length && (!anchor || text.slice(0, end).trimEnd().endsWith(anchor))) return end;
    if (anchor) {
        const index = text.indexOf(anchor);
        if (index >= 0 && index === text.lastIndexOf(anchor)) return index + anchor.length;
    }
    return null;
}

function safeLinks(root) {
    for (const link of root.querySelectorAll('a[href]')) {
        try {
            const url = new URL(link.getAttribute('href'));
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin === location.origin) throw new Error();
            link.href = url.href;
            link.rel = 'noreferrer noopener';
            link.target = '_blank';
        } catch { link.removeAttribute('href'); }
    }
}

function mediaSource(element) {
    return element.getAttribute('src') || element.querySelector('source[src]')?.getAttribute('src') || '';
}

function preserveAngleTags(raw, delimiters) {
    // A prompt can contain e.g. <lora:name:0.7>, which HTML parsing would discard.
    // Encode only inside recognized prompt markers, and leave examples in code alone.
    const code = [...raw.matchAll(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)\s*>|(`{3,}|~{3,})[\s\S]*?\1|(`+)[^\n]*?\2/gi)];
    for (const { start, end } of splitTags(raw, delimiters.start, delimiters.end).reverse()) {
        const marker = raw.slice(start, end);
        if (!/[<>]/.test(marker) || code.some(match => match.index < end && match.index + match[0].length > start)) continue;
        raw = raw.slice(0, start) + marker.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + raw.slice(end);
    }
    return raw;
}

export async function renderMessage(message, { rendered, format, sanitize, imageGroups, delimiters, normalize, gallery, assets, stats, signal }) {
    signal?.throwIfAborted();
    const live = rendered.get(message.index);
    const raw = delimiters.start === '<image>' || delimiters.end === '</image>'
        ? message.mes : message.mes.replace(/<\/?image\s*>/gi, '');
    let markup;
    try { markup = live ?? format(preserveAngleTags(raw, delimiters), message); } catch { markup = null; }
    const fragment = sanitize(markup ?? '', SANITIZE);
    const doc = fragment.ownerDocument;
    const root = doc.createElement('div');
    root.append(fragment);
    if (markup === null) {
        const plain = doc.createElement('pre');
        plain.textContent = raw;
        root.append(plain);
    }
    safeLinks(root);
    for (const node of root.querySelectorAll('[class]')) {
        if (node.className !== 'embedded') node.removeAttribute('class');
    }
    const shownTags = new Set();
    const shownUrls = new Set();

    function mediaNode(asset, alt = '聊天插图', moved = false) {
        const wrapper = doc.createElement('span');
        wrapper.className = 'media';
        if (!asset) {
            stats.missing++;
            wrapper.classList.add('media-missing');
            wrapper.textContent = '图片未能保存到此档案';
            return wrapper;
        }
        stats.embedded++;
        const media = doc.createElement(asset.mime.startsWith('video/') ? 'video' : 'img');
        media.setAttribute('src', asset.data);
        if (media.localName === 'video') {
            media.setAttribute('controls', '');
            media.setAttribute('playsinline', '');
            media.setAttribute('preload', 'none');
        } else {
            media.alt = alt || '聊天插图';
            media.loading = 'lazy';
            media.decoding = 'async';
        }
        wrapper.append(media);
        if (moved) {
            const note = doc.createElement('small');
            note.textContent = '原插图位置无法确认，已放在本条末尾。';
            wrapper.append(note);
        }
        return wrapper;
    }

    const keyFor = value => {
        const wrapped = splitTags(value || '', delimiters.start, delimiters.end)[0];
        return normalize(wrapped?.tag ?? value);
    };
    const placements = getPlacements(message, imageGroups, textPositions(root).text);
    const expected = new Set(placements.map(item => keyFor(item?.tag)).filter(Boolean));
    async function embedTag(tag, currentSource) {
        if (currentSource) {
            shownUrls.add(currentSource);
            const asset = await assets.embed(currentSource);
            if (asset) return asset;
        }
        const entry = gallery.lookup(tag);
        const stored = await gallery.read(entry);
        return stored ? assets.embed(stored, `chatu8:${entry.uuid}`) : null;
    }

    // Loaded messages supply the displayed variant and exact placement, even in same-origin frames.
    for (const slot of root.querySelectorAll(`[${TAG}]`)) {
        const key = normalize(slot.getAttribute(TAG));
        const media = slot.querySelector('img[src],video');
        if (key) shownTags.add(key);
        slot.replaceWith(mediaNode(await embedTag(key, media && mediaSource(media))));
    }
    for (const media of root.querySelectorAll('img,video')) {
        if (media.closest('.media')) continue;
        const source = mediaSource(media);
        if (!source) { media.remove(); continue; }
        shownUrls.add(source);
        media.replaceWith(mediaNode(await assets.embed(source), media.getAttribute('alt')));
    }
    root.querySelectorAll('source').forEach(node => node.remove());

    const { text, nodes } = textPositions(root);
    const edits = [];
    for (const match of splitTags(text, delimiters.start, delimiters.end)) {
        const protectedRange = nodes.some(info => info.end > match.start && info.start < match.end && info.node.parentElement?.closest('pre,code,a'));
        if (protectedRange) continue;
        const key = normalize(match.tag);
        if (!key) continue;
        if (delimiters.start === '[' && delimiters.end === ']' && !expected.has(key) && !gallery.lookup(key)) continue;
        shownTags.add(key);
        edits.push({ ...match, key });
    }
    for (const placement of placements) {
        const key = keyFor(placement?.tag);
        if (!key || shownTags.has(key)) continue;
        shownTags.add(key);
        const end = positionFor(text, placement);
        if (end === null || edits.some(edit => edit.start < end && end < edit.end)) {
            stats.moved++;
            root.append(mediaNode(await embedTag(key), undefined, true));
        } else edits.push({ start: end, end, key });
    }
    // Apply from the end to keep UTF-16 positions stable as prompt text is replaced.
    edits.sort((a, b) => b.end - a.end || b.start - a.start);
    for (const { start, end, key } of edits) insertAt(root, end, mediaNode(await embedTag(key)), start);
    for (const attachment of message.attachments) {
        if (shownUrls.has(attachment.url)) continue;
        shownUrls.add(attachment.url);
        root.append(mediaNode(await assets.embed(attachment.url)));
    }
    return root.innerHTML;
}
