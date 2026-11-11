import { DOMPurify } from '../../../../lib.js';
import { chatIdentity, md5, messagePrefixHashes, snapshotChat } from './model.js';
import { captureRenderedMessages } from './render.js';
import { buildArchiveParts } from './document.js';
import { describeMediaFailures } from './assets.js';
import { createRegexFilter, parseRemovalRules, RegexFilterError } from './regex-filter.js';

const getContext = () => globalThis.SillyTavern.getContext();
const sanitizer = DOMPurify(window);
const INCLUDE_USER_SETTING = 'st-html-export.include-user';
const REGEX_RULES_SETTING = 'st-html-export.regex-rules';
const EXAMPLE_RULES = String.raw`/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
/<(options|choices)\b[^>]*>[\s\S]*?<\/\1\s*>/gi`;

function progressKey(identity, includeUser) {
    return identity && `st-html-export.progress.v1:${md5(JSON.stringify([identity, includeUser]))}`;
}

function readProgress(key) {
    if (!key) return null;
    try {
        const value = JSON.parse(localStorage.getItem(key));
        if (Number.isSafeInteger(value?.end) && value.end > 0 && /^[a-f0-9]{32}$/.test(value.hash)) return value;
    } catch { /* No usable saved progress. */ }
    return null;
}

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
    const resumeOption = element('label', 'sthe-option');
    const resume = element('input');
    resume.type = 'checkbox';
    resumeOption.append(resume, '只导出上次之后的消息');
    const resumeFields = element('div', 'sthe-resume-fields');
    resumeFields.hidden = true;
    const fromLabel = element('label', 'sthe-option', '从第几条消息开始');
    const from = element('input');
    from.type = 'number';
    from.min = '1';
    from.step = '1';
    from.placeholder = '留空自动接续';
    fromLabel.append(from);
    const resumeHint = element('p', 'sthe-resume-hint');
    resumeFields.append(fromLabel, resumeHint);
    const splitOption = element('label', 'sthe-option');
    const split = element('input');
    split.type = 'checkbox';
    splitOption.append(split, '自动分段导出（适合图片较多的聊天）');
    const option = element('label', 'sthe-option');
    const external = element('input');
    external.type = 'checkbox';
    option.append(external, '尝试保存聊天中的外链图片（会访问图片网站）');
    const regexOption = element('label', 'sthe-option');
    const regexEnabled = element('input');
    regexEnabled.type = 'checkbox';
    regexOption.append(regexEnabled, '用正则移除导出内容');
    const regexFields = element('div', 'sthe-regex-fields');
    regexFields.hidden = true;
    const ruleLabel = element('label', null, '要移除的内容');
    const ruleEditor = element('textarea');
    ruleEditor.rows = 4;
    ruleEditor.spellcheck = false;
    ruleEditor.value = EXAMPLE_RULES;
    try { ruleEditor.value = localStorage.getItem(REGEX_RULES_SETTING) ?? EXAMPLE_RULES; }
    catch { /* Use the examples when storage is disabled. */ }
    ruleLabel.append(ruleEditor);
    regexFields.append(ruleLabel, element('small', null, '每行一条 /表达式/标志。初始规则匹配 <think>、<thinking>、<options> 和 <choices> 块。'));
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
    dialog.append(header, info, userOption, resumeOption, resumeFields, splitOption, option, regexOption, regexFields, progress, status, actions);
    document.body.append(dialog);

    let controller = null;
    let resultUrl = null;
    let recordDownload = null;
    function clearResult(delay = 0) {
        if (resultUrl) {
            const oldUrl = resultUrl;
            if (delay) setTimeout(() => URL.revokeObjectURL(oldUrl), delay);
            else URL.revokeObjectURL(oldUrl);
        }
        resultUrl = null;
        recordDownload = null;
        download.hidden = next.hidden = true;
        download.removeAttribute('href');
    }
    function updateResumeHint() {
        const saved = readProgress(progressKey(chatIdentity(getContext()), includeUser.checked));
        resumeHint.textContent = saved
            ? `已记录到原聊天第 ${saved.end} 条。留空从第 ${saved.end + 1} 条开始。`
            : '当前聊天没有可用的下载进度。旧版导过的话，可以填下一条消息的编号，从 1 开始数，包含你发的消息。';
    }

    download.addEventListener('click', () => recordDownload?.());
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
        if (resume.checked) updateResumeHint();
    });
    resume.addEventListener('change', () => {
        resumeFields.hidden = !resume.checked;
        if (resume.checked) updateResumeHint();
        clearResult();
        status.textContent = '';
    });
    from.addEventListener('input', () => { clearResult(); status.textContent = ''; });
    split.addEventListener('change', () => { clearResult(); status.textContent = ''; });
    regexEnabled.addEventListener('change', () => {
        regexFields.hidden = !regexEnabled.checked;
        clearResult();
        status.textContent = '';
    });
    ruleEditor.addEventListener('input', () => {
        clearResult();
        status.textContent = '';
        try { localStorage.setItem(REGEX_RULES_SETTING, ruleEditor.value); }
        catch { /* The current rules remain available in the editor. */ }
    });
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
        start.disabled = includeUser.disabled = resume.disabled = from.disabled = split.disabled = external.disabled = true;
        regexEnabled.disabled = ruleEditor.disabled = true;
        progress.hidden = cancel.hidden = false;
        progress.value = 0;
        status.textContent = '正在读取消息和图片…';
        const identity = chatIdentity(context);
        const changed = () => { if (chatIdentity(getContext()) !== identity) controller?.abort(); };
        const chatChanged = context.eventTypes?.CHAT_CHANGED || context.event_types?.CHAT_CHANGED;
        const subscribe = chatChanged && typeof context.eventSource?.removeListener === 'function';
        if (subscribe) context.eventSource.on(chatChanged, changed);
        let regexFilter;
        try {
            const rules = regexEnabled.checked ? parseRemovalRules(ruleEditor.value) : null;
            const key = progressKey(identity, includeUser.checked);
            const hashes = key ? messagePrefixHashes(context.chat) : [];
            const resumeExport = resume.checked;
            let startIndex = 0;
            if (resumeExport) {
                if (from.validity.badInput || (from.value !== '' && (!Number.isSafeInteger(from.valueAsNumber) || from.valueAsNumber < 1 || from.valueAsNumber > context.chat.length))) {
                    status.textContent = `请输入 1 到 ${context.chat.length} 之间的消息编号。`;
                    return;
                }
                if (from.value !== '') startIndex = from.valueAsNumber - 1;
                else {
                    const saved = readProgress(key);
                    if (!saved || hashes[saved.end] !== saved.hash) {
                        status.textContent = saved ? '上次导出前的消息有变动。请填写起点，或取消勾选后完整导出。' : '还没有这段聊天的下载进度。请填写起点，或取消勾选后完整导出。';
                        return;
                    }
                    startIndex = saved.end;
                }
            }
            const snapshot = snapshotChat(context, { includeUser: includeUser.checked, startIndex });
            if (!snapshot.messages.length) { status.textContent = resumeExport ? '没有符合当前选项的新消息。' : '没有符合当前选项的消息。'; return; }
            progress.max = snapshot.messages.length;
            const rendered = captureRenderedMessages(document.getElementById('chat'), new Set(snapshot.messages.map(message => message.index)));
            const settings = context.extensionSettings?.['st-chatu8'] || {};
            const splitExport = split.checked;
            if (rules) regexFilter = createRegexFilter(rules, signal);
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
                regexFilter,
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
                const first = snapshot.messages[done - count].index + 1;
                const end = snapshot.messages[done - 1].index + 1;
                download.download = resumeExport ? `${filename.slice(0, -5)}-消息${first}-${end}.html` : filename;
                recordDownload = key ? () => {
                    recordDownload = null;
                    try {
                        const previous = readProgress(key);
                        if (!previous || previous.end <= end || hashes[previous.end] !== previous.hash) {
                            localStorage.setItem(key, JSON.stringify({ end, hash: hashes[end] }));
                        }
                        if (resumeExport) { from.value = ''; updateResumeHint(); }
                    } catch { status.textContent += ' 浏览器无法记录本次下载进度。'; }
                } : null;
                download.textContent = splitExport ? `下载第 ${part} 段` : '下载 HTML';
                download.hidden = false;
                const size = blob.size >= 1048576 ? `${(blob.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
                status.textContent = (splitExport ? `第 ${part} 段已生成（${done} / ${total} 条）。` : '')
                    + `本文件有 ${count} 条消息、${stats.embedded} 项媒体（${size}）。`
                    + (stats.missing ? ` ${stats.missing} 项媒体未能保存（${describeMediaFailures(stats.failures)}），已在档案中标记。` : '')
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
            if (signal.aborted) status.textContent = '已取消导出。';
            else if (error instanceof RegexFilterError) status.textContent = error.message;
            else status.textContent = '导出未完成。请刷新酒馆后重试。';
            if (!signal.aborted) console.warn('[ST HTML Export] Export failed:', error?.name || 'Error');
        } finally {
            regexFilter?.close();
            if (subscribe) context.eventSource.removeListener(chatChanged, changed);
            controller = null;
            start.disabled = includeUser.disabled = resume.disabled = from.disabled = split.disabled = external.disabled = false;
            regexEnabled.disabled = ruleEditor.disabled = false;
            progress.hidden = cancel.hidden = true;
        }
    });

    function show() {
        if (!controller) {
            status.textContent = '';
            resume.checked = false;
            resumeFields.hidden = true;
            from.value = '';
        }
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
