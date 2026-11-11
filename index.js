import { DOMPurify } from '../../../../lib.js';
import { snapshotChat } from './model.js';
import { captureRenderedMessages } from './render.js';
import { buildArchiveParts } from './document.js';

const getContext = () => globalThis.SillyTavern.getContext();
const sanitizer = DOMPurify(window);
const INCLUDE_USER_SETTING = 'st-html-export.include-user';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function install() {
    if (document.getElementById('sthe-dialog')) return;
    const menu = document.getElementById('extensionsMenu');
    const settingsPanel = document.getElementById('extensions_settings');
    if (!menu && !settingsPanel) return;

    const dialog = element('dialog', 'sthe-dialog');
    dialog.id = 'sthe-dialog';
    dialog.setAttribute('aria-labelledby', 'sthe-title');
    const header = element('div', 'sthe-header');
    const title = element('h2', null, '导出聊天为 HTML');
    title.id = 'sthe-title';
    const close = element('button', 'menu_button sthe-close', '关闭');
    close.type = 'button';
    header.append(title, close);

    const info = element('p', null, '保存当前聊天和可用插图。导出文件可离线打开。');
    const userOption = element('label', 'sthe-option');
    const includeUser = element('input');
    includeUser.type = 'checkbox';
    includeUser.checked = true;
    try { includeUser.checked = localStorage.getItem(INCLUDE_USER_SETTING) !== 'false'; }
    catch { /* Storage may be disabled. */ }
    userOption.append(includeUser, '包含我的消息');
    const splitOption = element('label', 'sthe-option');
    const split = element('input');
    split.type = 'checkbox';
    splitOption.append(split, '自动分段导出（适合图片较多的聊天）');
    const option = element('label', 'sthe-option');
    const external = element('input');
    external.type = 'checkbox';
    option.append(external, '尝试保存聊天中的外链图片（会访问图片网站）');
    const progress = element('progress', 'sthe-progress');
    progress.hidden = true;
    progress.setAttribute('aria-label', '导出进度');
    const status = element('p', 'sthe-status');
    status.setAttribute('role', 'status');
    const actions = element('div', 'sthe-actions');
    const start = element('button', 'menu_button', '生成 HTML');
    const cancel = element('button', 'menu_button', '取消导出');
    start.type = cancel.type = 'button';
    cancel.hidden = true;
    const download = element('a', 'menu_button sthe-download', '下载 HTML');
    download.hidden = true;
    const next = element('button', 'menu_button', '生成下一段');
    next.type = 'button';
    next.hidden = true;
    actions.append(start, cancel, download, next);
    dialog.append(header, info, userOption, splitOption, option, progress, status, actions);
    document.body.append(dialog);

    let controller = null;
    let resultUrl = null;
    function clearResult(delay = 0) {
        if (resultUrl) {
            const oldUrl = resultUrl;
            if (delay) setTimeout(() => URL.revokeObjectURL(oldUrl), delay);
            else URL.revokeObjectURL(oldUrl);
        }
        resultUrl = null;
        download.hidden = next.hidden = true;
        download.removeAttribute('href');
    }
    function waitForNextPart(signal) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const enableNext = () => { next.disabled = false; };
            const cleanup = () => {
                download.removeEventListener('click', enableNext);
                next.removeEventListener('click', proceed);
                signal.removeEventListener('abort', abort);
            };
            const proceed = () => { cleanup(); resolve(); };
            const abort = () => { cleanup(); reject(signal.reason); };
            next.disabled = true;
            next.hidden = false;
            download.addEventListener('click', enableNext, { once: true });
            next.addEventListener('click', proceed, { once: true });
            signal.addEventListener('abort', abort, { once: true });
        });
    }
    includeUser.addEventListener('change', () => {
        try { localStorage.setItem(INCLUDE_USER_SETTING, String(includeUser.checked)); }
        catch { /* The choice still applies to this page. */ }
        clearResult();
        status.textContent = '';
    });
    split.addEventListener('change', () => { clearResult(); status.textContent = ''; });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
        controller?.abort();
        clearResult(30000);
    });
    cancel.addEventListener('click', () => controller?.abort());
    start.addEventListener('click', async () => {
        if (controller) return;
        const context = getContext();
        if (!context.chat?.length) { status.textContent = '请先打开一段聊天。'; return; }
        clearResult();
        controller = new AbortController();
        const { signal } = controller;
        start.disabled = includeUser.disabled = split.disabled = external.disabled = true;
        progress.hidden = cancel.hidden = false;
        progress.value = 0;
        status.textContent = '正在读取消息和图片…';
        const getId = ctx => [ctx.getCurrentChatId?.() ?? ctx.chatId, ctx.characterId, ctx.groupId].join('\u0000');
        const identity = getId(context);
        const changed = () => { if (getId(getContext()) !== identity) controller?.abort(); };
        const chatChanged = context.eventTypes?.CHAT_CHANGED || context.event_types?.CHAT_CHANGED;
        const subscribe = chatChanged && typeof context.eventSource?.removeListener === 'function';
        if (subscribe) context.eventSource.on(chatChanged, changed);
        try {
            const snapshot = snapshotChat(context, { includeUser: includeUser.checked });
            if (!snapshot.messages.length) { status.textContent = '没有符合当前选项的消息。'; return; }
            progress.max = snapshot.messages.length;
            const rendered = captureRenderedMessages(document.getElementById('chat'));
            const settings = context.extensionSettings?.['st-chatu8'] || {};
            const splitExport = split.checked;
            for await (const result of buildArchiveParts(snapshot, {
                rendered,
                format: (raw, message) => {
                    // ST's formatter can save macro substitutions into message zero.
                    // Supply the expanded greeting and omit its ID to keep this export read-only.
                    const first = message.index === 0;
                    const value = first && !message.is_user && !message.is_system
                        ? (context.substituteParams?.(raw, undefined, message.name) ?? raw) : raw;
                    return context.messageFormatting(value, message.name, message.is_system, message.is_user, first ? undefined : message.index);
                },
                sanitize: (html, config) => sanitizer.sanitize(html, config),
                settings,
                substitute: value => value.includes('{{') ? (context.substituteParams?.(value) ?? value) : value,
                external: external.checked,
                split: splitExport,
                signal,
                onProgress({ done, total }) {
                    changed();
                    progress.value = done;
                    status.textContent = `已处理 ${done} / ${total} 条消息…`;
                },
            })) {
                signal.throwIfAborted();
                const { blob, stats, part, count, done, total, more, filename } = result;
                resultUrl = URL.createObjectURL(blob);
                download.href = resultUrl;
                download.download = filename;
                download.textContent = splitExport ? `下载第 ${part} 段` : '下载 HTML';
                download.hidden = false;
                const size = blob.size >= 1048576 ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
                status.textContent = (splitExport ? `第 ${part} 段已生成（${done} / ${total} 条）。` : '')
                    + `本文件有 ${count} 条消息、${stats.embedded} 项媒体（${size}）。`
                    + (stats.missing ? ` ${stats.missing} 项媒体未能保存，已在档案中标记。` : '')
                    + (stats.moved ? ` ${stats.moved} 项插图移至对应消息末尾。` : '')
                    + (stats.limitReached ? (splitExport ? ' 本段有单条消息的图片超过容量上限。' : ' 已达单文件图片大小上限。可勾选「自动分段导出」重试。') : '')
                    + (more ? ' 下载本段后，点「生成下一段」。' : splitExport ? ' 这是最后一段。' : '');
                download.focus();
                if (more) {
                    await waitForNextPart(signal);
                    clearResult(3000);
                    status.textContent = '正在读取下一段消息和图片…';
                }
            }
        } catch (error) {
            clearResult(3000);
            status.textContent = signal.aborted ? '已取消导出。' : '导出未完成。请刷新酒馆后重试。';
            if (!signal.aborted) console.warn('[ST HTML Export] Export failed:', error?.name || 'Error');
        } finally {
            if (subscribe) context.eventSource.removeListener(chatChanged, changed);
            controller = null;
            start.disabled = includeUser.disabled = split.disabled = external.disabled = false;
            progress.hidden = cancel.hidden = true;
        }
    });

    function show() {
        if (!controller) status.textContent = '';
        if (!dialog.open) dialog.showModal();
    }
    if (menu) {
        const trigger = element('button', 'list-group-item sthe-menu', '导出聊天为 HTML');
        trigger.id = 'sthe-export-menu';
        trigger.type = 'button';
        trigger.addEventListener('click', show);
        menu.append(trigger);
    }
    if (settingsPanel) {
        const trigger = element('button', 'menu_button sthe-settings', '导出聊天为 HTML');
        trigger.type = 'button';
        trigger.addEventListener('click', show);
        settingsPanel.append(trigger);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
