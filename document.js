import { normalizeTag } from './model.js';
import { openChatu8 } from './chatu8.js';
import { createAssetLoader, describeMediaFailures, MAX_EMBEDDED } from './assets.js';
import { renderMessage } from './render.js';

export const archiveCss = `
:root{color-scheme:light dark;--bg:#f5f2eb;--paper:#fffcf5;--ink:#26261f;--muted:#625d51;--line:#ded7c9;--accent:#32534a;--mine:#e7f0e9}
@media(prefers-color-scheme:dark){:root{--bg:#171b19;--paper:#212824;--ink:#e9ede7;--muted:#b7c0b6;--line:#3b463e;--accent:#afcebe;--mine:#263630}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;color:var(--ink);font:16px/1.72 system-ui,-apple-system,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
.wrap{max-width:820px;margin:auto;padding:30px clamp(12px,4vw,34px) 44px}.cover{border-bottom:1px solid var(--line);padding:4px 0 24px;margin-bottom:22px}
.eyebrow{color:var(--accent);letter-spacing:.13em;font-size:.74rem;font-weight:800;margin:0 0 8px}.cover h1{margin:0;font:700 clamp(1.65rem,5vw,2.7rem)/1.2 ui-serif,"Songti SC",serif;letter-spacing:-.02em}
.meta,.summary,.time,footer{font-size:.82rem;color:var(--muted)}.meta{margin:.65rem 0 0}.summary{margin:.5rem 0 0}.note{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:12px 0 0}
.message{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:clamp(12px,3vw,21px);margin:0 0 13px}.message.mine{background:var(--mine)}
.message>header{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}.speaker{font-weight:750;color:var(--accent)}.time{margin-left:auto}.body>:first-child{margin-top:0}.body>:last-child{margin-bottom:0}.body p{margin:.55em 0}.body h1,.body h2,.body h3{line-height:1.25}.body h1{font-size:1.4em}.body h2{font-size:1.25em}
blockquote{margin:.6em 0;padding:.2em .85em;border-inline-start:3px solid var(--line);color:var(--muted)}pre{white-space:pre-wrap;background:var(--bg);padding:.7em;border-radius:8px}code{font-family:ui-monospace,Consolas,monospace;font-size:.91em}a{color:var(--accent)}q:before,q:after{content:none}
table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:4px 8px;border:1px solid var(--line)}.embedded{padding:.6em;border:1px solid var(--line);border-radius:8px}
.media{display:block;margin:12px 0}.media img,.media video{display:block;max-width:100%;height:auto;border-radius:9px}.media small{color:var(--muted);display:block;margin-top:5px}.media-missing{font-size:.85em;color:var(--muted);padding:7px 10px;border:1px dashed var(--line);border-radius:7px}
footer{border-top:1px solid var(--line);margin-top:20px;padding-top:12px}@media print{.wrap{max-width:none;padding:0}.message{break-inside:auto}.media{break-inside:avoid}.media img{max-height:75vh;object-fit:contain}}
`;

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function fileName(title) {
    const clean = String(title).replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').trim().replace(/[. ]+$/g, '');
    return `酒馆聊天-${Array.from(clean || '记录').slice(0, 90).join('')}.html`;
}

export function wrapArchive(title, articles, stats, timestamp = new Date()) {
    const time = timestamp.toLocaleString('zh-CN', { hour12: false });
    const notes = [
        stats.missing ? `${stats.missing} 项图片或视频未能内嵌（${describeMediaFailures(stats.failures)}）。` : '',
        stats.moved ? `${stats.moved} 项插图放在对应消息末尾。` : '',
        stats.limitReached ? '已达到单文件图片大小上限。' : '',
    ].filter(Boolean).join(' ');
    const head = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${archiveCss}</style></head><body><main class="wrap"><header class="cover"><p class="eyebrow">SILLYTAVERN · 聊天归档</p><h1>${escapeHtml(title)}</h1><p class="meta">导出于 ${escapeHtml(time)}</p><p class="summary">${articles.length} 条消息 · ${stats.embedded} 项内嵌媒体</p>${notes ? `<p class="summary note">${escapeHtml(notes)}</p>` : ''}</header>`;
    return new Blob([head, ...articles, '<footer>离线聊天记录 · SillyTavern</footer></main></body></html>'], { type: 'text/html;charset=utf-8' });
}

const newStats = () => ({ embedded: 0, missing: 0, moved: 0, failures: {} });

export async function* buildArchiveParts(snapshot, { rendered = new Map(), format, sanitize, settings = {}, substitute, external = false, signal, onProgress = () => {}, base, maxEmbedded = MAX_EMBEDDED, split = false }) {
    const gallery = await openChatu8(settings, signal);
    const assets = createAssetLoader({ base, external, signal, maxEmbedded });
    const delimiters = { start: settings.startTag || 'image###', end: settings.endTag || '###' };
    const normalize = value => normalizeTag(value, substitute);
    const timestamp = new Date();
    const total = snapshot.messages.length;
    let articles = [];
    let stats = newStats();
    let partBytes = 0;
    let done = 0;
    let part = 1;

    function finishPart(more) {
        const title = split ? `${snapshot.title} · 第 ${part} 段` : snapshot.title;
        const filename = fileName(snapshot.title);
        const suffix = String(part).padStart(3, '0');
        const partStats = { ...stats, limitReached: Boolean(stats.failures.budget) };
        return {
            blob: wrapArchive(title, articles, partStats, timestamp),
            filename: split ? `${filename.slice(0, -5)}-${suffix}.html` : filename,
            part, more, done, total, count: articles.length, stats: partStats,
        };
    }

    try {
        for (const message of snapshot.messages) {
            signal?.throwIfAborted();
            if (split) assets.resetBudget();
            const messageStats = newStats();
            const body = await renderMessage(message, { rendered, format, sanitize, imageGroups: snapshot.imageGroups, delimiters, normalize, gallery, assets, stats: messageStats, signal });
            if (split) rendered.delete(message.index);
            const article = `<article class="message${message.is_user ? ' mine' : ''}"><header><span class="speaker">${escapeHtml(message.name)}</span>${message.date ? `<span class="time">${escapeHtml(message.date)}</span>` : ''}</header><div class="body">${body}</div></article>`;
            const bytes = assets.embeddedBytes;
            if (split && articles.length && partBytes + bytes > maxEmbedded) {
                // Keep the boundary message intact in the next part, including any media already read.
                const finished = finishPart(true);
                articles = [];
                stats = newStats();
                partBytes = 0;
                assets.clearCache();
                yield finished;
                signal?.throwIfAborted();
                part++;
            }
            articles.push(article);
            stats.embedded += messageStats.embedded;
            stats.missing += messageStats.missing;
            stats.moved += messageStats.moved;
            for (const [reason, count] of Object.entries(messageStats.failures)) {
                stats.failures[reason] = (stats.failures[reason] || 0) + count;
            }
            partBytes = split ? partBytes + bytes : bytes;
            done++;
            onProgress({ done, total });
            // Keep the mobile cancel button and progress indicator responsive on text-heavy chats.
            if (done % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        signal?.throwIfAborted();
        yield finishPart(false);
    } finally { gallery.close(); }
}
