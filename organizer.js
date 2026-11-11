import { createRegexFilter, parseRule, parseRules } from './regex-filter.js';
import { captureRenderedMessages, previewMessage } from './render.js';
import { tagBlocks } from './tags.js';

const DELETE_KEY = 'st-html-export.regex-rules';
const KEEP_KEY = 'st-html-export.regex-keep';
const REPLACE_KEY = 'st-html-export.regex-replace';
const DEFAULT_DELETE = String.raw`/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
/<(options|choices)\b[^>]*>[\s\S]*?<\/\1\s*>/gi`;
const tagActions = [['', '保留原样'], ['remove', '删除整块'], ['unwrap', '只删标签'], ['keep', '只保留块内正文']];
const commonCleanupTags = new Set(['<think>', '<thinking>', '<options>', '<choices>', '<details>', '[思考]', '[选项]']);

export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function readSetting(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch { return fallback; }
}

function writeSetting(key, value) {
    try { localStorage.setItem(key, value); }
    catch { /* The settings still apply in the open panel. */ }
}

function readJson(key, fallback) {
    try { return JSON.parse(readSetting(key, 'null')) ?? fallback; }
    catch { return fallback; }
}

function button(label) {
    const control = element('button', 'menu_button', label);
    control.type = 'button';
    return control;
}

export function createOrganizer({ selection, getChatKey, onChange }) {
    const panel = element('section', 'sthe-organizer');
    panel.id = 'sthe-organizer';
    panel.hidden = true;

    const previewArea = element('section', 'sthe-panel');
    const previewHeader = element('div', 'sthe-section-header');
    const previewTitle = element('h3', null, '文字预览');
    const previewLabel = element('label', 'sthe-inline', '原聊天消息编号');
    const previewIndex = element('input');
    previewIndex.type = 'number';
    previewIndex.min = '1';
    previewIndex.placeholder = '最近两条';
    previewLabel.append(previewIndex);
    previewHeader.append(previewTitle, previewLabel);
    const previewList = element('div', 'sthe-preview-list');
    const previewStatus = element('small', 'sthe-preview-status', '插图预览使用占位符。');
    previewStatus.setAttribute('aria-live', 'polite');
    previewArea.append(previewHeader, previewList, previewStatus);

    const tagsArea = element('section', 'sthe-panel');
    const tagsHeader = element('div', 'sthe-section-header');
    const scanButton = button('识别标签');
    const tagsStatus = element('small', null, '从当前导出范围识别成对标签。');
    const tagsList = element('div', 'sthe-tags-list');
    tagsHeader.append(element('h3', null, '标签整理'), scanButton);
    tagsArea.append(tagsHeader, tagsStatus, tagsList);

    const regexArea = element('section', 'sthe-panel');
    const regexHeader = element('div', 'sthe-section-header');
    const regexLabel = element('label', 'sthe-option');
    const regexEnabled = element('input');
    regexEnabled.type = 'checkbox';
    regexLabel.append(regexEnabled, '使用自定义正则');
    regexHeader.append(element('h3', null, '正则规则'), regexLabel);
    const regexFields = element('div', 'sthe-regex-fields');
    regexFields.hidden = true;
    const keepLabel = element('label', null, '只保留匹配内容');
    const keepEditor = element('textarea');
    keepEditor.rows = 2;
    keepEditor.spellcheck = false;
    keepEditor.value = readSetting(KEEP_KEY, '');
    keepEditor.placeholder = '/需要保留的内容/g';
    keepLabel.append(keepEditor);
    const replaceHeading = element('div', 'sthe-section-header');
    const addReplace = button('添加替换');
    replaceHeading.append(element('span', null, '替换内容'), addReplace);
    const replaceList = element('div', 'sthe-replace-list');
    const deleteLabel = element('label', null, '要移除的内容');
    const deleteEditor = element('textarea');
    deleteEditor.rows = 3;
    deleteEditor.spellcheck = false;
    deleteEditor.value = readSetting(DELETE_KEY, DEFAULT_DELETE);
    deleteLabel.append(deleteEditor);
    regexFields.append(keepLabel, replaceHeading, replaceList, deleteLabel,
        element('small', null, '每行使用 /表达式/标志。先保留匹配，再替换，最后删除。保留规则未匹配时会保留原文。'));
    regexArea.append(regexHeader, regexFields);
    panel.append(previewArea, tagsArea, regexArea);

    let tagKey;
    let actions = {};
    let foundTags = new Map();
    let scanId = 0;
    let previewController;
    let previewTimer;
    let busy = false;
    const replacements = [];

    function syncTags() {
        const key = getChatKey();
        if (key === tagKey) return;
        tagKey = key;
        const saved = key ? readJson(key, {}) : {};
        actions = Object.fromEntries(Object.entries(saved).filter(([tag, action]) => (
            /^(?:<[^<>]+>|\[[^\[\]]+\])$/.test(tag) && ['remove', 'unwrap', 'keep'].includes(action)
        )));
        foundTags = new Map();
    }

    function filters() {
        syncTags();
        const rules = regexEnabled.checked ? [
            ...parseRules(keepEditor.value, 'keep'),
            ...replacements.flatMap(({ find, replacement }, index) => find.value.trim() ? [parseRule(find.value, 'replace', index + 1, replacement.value)] : []),
            ...parseRules(deleteEditor.value),
        ] : [];
        return { rules, tags: { ...actions } };
    }

    function persistRegex() {
        writeSetting(DELETE_KEY, deleteEditor.value);
        writeSetting(KEEP_KEY, keepEditor.value);
        writeSetting(REPLACE_KEY, JSON.stringify(replacements.map(({ find, replacement }) => [find.value, replacement.value])));
    }

    function edited() {
        onChange();
        schedulePreview();
    }

    function replacementRow(pattern = '', value = '') {
        const row = element('div', 'sthe-replace-row');
        const find = element('input');
        find.setAttribute('aria-label', '查找表达式');
        find.placeholder = '/查找/g';
        find.value = pattern;
        const replacement = element('input');
        replacement.setAttribute('aria-label', '替换为');
        replacement.placeholder = '替换为';
        replacement.value = value;
        const remove = button('移除');
        const item = { find, replacement };
        replacements.push(item);
        row.append(find, replacement, remove);
        replaceList.append(row);
        row.addEventListener('input', () => { persistRegex(); edited(); });
        remove.addEventListener('click', () => {
            replacements.splice(replacements.indexOf(item), 1);
            row.remove();
            persistRegex();
            edited();
        });
        return find;
    }

    const storedReplacements = readJson(REPLACE_KEY, []);
    if (Array.isArray(storedReplacements)) {
        for (const pair of storedReplacements) {
            if (Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === 'string')) replacementRow(...pair);
        }
    }

    function paintTags() {
        tagsList.replaceChildren();
        const names = new Set([...foundTags.keys(), ...Object.keys(actions)]);
        const priority = name => actions[name] ? 2 : Number(commonCleanupTags.has(name));
        const sorted = [...names].sort((a, b) => priority(b) - priority(a) || (foundTags.get(b) ?? 0) - (foundTags.get(a) ?? 0) || a.localeCompare(b));
        for (const name of sorted) {
            const row = element('label', 'sthe-tag-row');
            const label = element('span');
            label.append(element('code', null, name), element('small', null, ` ${foundTags.get(name) ?? 0} 处`));
            const select = element('select');
            select.setAttribute('aria-label', `处理 ${name}`);
            for (const [value, title] of tagActions) {
                const option = element('option', null, title);
                option.value = value;
                select.append(option);
            }
            select.value = actions[name] || '';
            select.disabled = busy;
            select.addEventListener('change', () => {
                if (select.value) actions[name] = select.value;
                else delete actions[name];
                if (tagKey) writeSetting(tagKey, JSON.stringify(actions));
                edited();
            });
            row.append(label, select);
            tagsList.append(row);
        }
    }

    async function scan() {
        const id = ++scanId;
        syncTags();
        tagsStatus.textContent = '正在识别标签…';
        try {
            const { messages } = selection();
            const counts = new Map();
            for (const [index, message] of messages.entries()) {
                for (const { tag } of tagBlocks(message.mes)) counts.set(tag, (counts.get(tag) || 0) + 1);
                if (index % 20 === 19) await new Promise(resolve => setTimeout(resolve, 0));
                if (id !== scanId) return;
            }
            foundTags = counts;
            paintTags();
            tagsStatus.textContent = counts.size ? `识别到 ${counts.size} 种成对标签。` : '选定范围里没有找到成对标签。';
        } catch (error) {
            if (id === scanId) tagsStatus.textContent = error.message;
        }
    }

    async function refreshPreview() {
        const controller = new AbortController();
        previewController = controller;
        const { signal } = controller;
        let filter;
        try {
            const { messages, format, sanitize, delimiters } = selection();
            const chosen = previewIndex.value ? messages.filter(message => message.index + 1 === previewIndex.valueAsNumber) : messages.slice(-2);
            if (!chosen.length) throw new Error('当前导出范围里没有对应消息。');
            const { rules, tags } = filters();
            if (rules.length || Object.keys(tags).length) filter = createRegexFilter(rules, signal, tags);
            const rendered = captureRenderedMessages(document.getElementById('chat'), new Set(chosen.map(message => message.index)));
            const cards = [];
            for (const message of chosen) {
                const text = await previewMessage(message, { rendered, format, sanitize, delimiters, signal, regexFilter: filter });
                const card = element('article', 'sthe-preview-card');
                card.append(element('strong', null, `${message.name} · 第 ${message.index + 1} 条`),
                    element('p', null, text || '（处理后为空）'));
                cards.push(card);
            }
            signal.throwIfAborted();
            previewList.replaceChildren(...cards);
            previewStatus.textContent = '插图预览使用占位符。';
        } catch (error) {
            if (!signal.aborted) {
                previewList.replaceChildren();
                previewStatus.textContent = error.message;
            }
        } finally { filter?.close(); }
    }

    function schedulePreview() {
        clearTimeout(previewTimer);
        previewController?.abort();
        if (!panel.hidden && !busy) previewTimer = setTimeout(refreshPreview, 180);
    }

    previewIndex.addEventListener('input', schedulePreview);
    scanButton.addEventListener('click', scan);
    regexEnabled.addEventListener('change', () => { regexFields.hidden = !regexEnabled.checked; edited(); });
    for (const editor of [keepEditor, deleteEditor]) editor.addEventListener('input', () => { persistRegex(); edited(); });
    addReplace.addEventListener('click', () => replacementRow().focus());

    return {
        panel,
        filters,
        summary() {
            syncTags();
            const count = Object.keys(actions).length;
            return [count ? `${count} 项标签处理` : '', regexEnabled.checked ? '已开启自定义正则' : ''].filter(Boolean).join(' · ');
        },
        open() {
            syncTags();
            paintTags();
            previewList.replaceChildren();
            previewStatus.textContent = '正在生成预览…';
            scan();
            schedulePreview();
        },
        close() { scanId++; clearTimeout(previewTimer); previewController?.abort(); },
        setBusy(value) {
            busy = value;
            for (const control of panel.querySelectorAll('button, input, textarea, select')) control.disabled = value;
            schedulePreview();
        },
    };
}
