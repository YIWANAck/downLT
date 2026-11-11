export class RegexFilterError extends Error {}

export function parseRemovalRules(text) {
    const rules = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const parts = /^\/(.+)\/([a-z]*)$/i.exec(line.trim());
        if (!parts) throw new RegexFilterError(`第 ${index + 1} 行请使用 /表达式/标志 格式。`);
        const [, pattern, flags] = parts;
        try { new RegExp(pattern, flags); }
        catch { throw new RegexFilterError(`第 ${index + 1} 行的正则表达式或标志无效。`); }
        rules.push({ pattern, flags });
    }
    if (!rules.length) throw new RegexFilterError('请填写至少一条要移除内容的正则规则。');
    return rules;
}

export function createRegexFilter(rules, signal) {
    let worker;
    try { worker = new Worker(new URL('./regex-worker.js', import.meta.url), { type: 'module' }); }
    catch { throw new RegexFilterError('无法启动正则过滤。可取消勾选后正常导出。'); }
    worker.postMessage({ rules });

    return {
        apply(raw, live) {
            signal?.throwIfAborted();
            return new Promise((resolve, reject) => {
                function finish(callback, value) {
                    clearTimeout(timeout);
                    signal?.removeEventListener('abort', abort);
                    worker.onmessage = worker.onerror = null;
                    callback(value);
                }
                const abort = () => finish(reject, signal.reason);
                const timeout = setTimeout(() => finish(reject, new RegexFilterError('正则过滤超时。请缩小匹配范围或关闭过滤后重试。')), 2000);
                worker.onmessage = event => finish(resolve, event.data);
                worker.onerror = () => finish(reject, new RegexFilterError('正则过滤无法运行。可取消勾选后正常导出。'));
                signal?.addEventListener('abort', abort, { once: true });
                worker.postMessage({ raw, live });
            });
        },
        close() { worker.terminate(); },
    };
}
