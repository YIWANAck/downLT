import { applyTagActions, mergeRanges } from './tags.js';

let steps = [];

function applyRule(value, { expression, action, replacement }) {
    if (typeof value !== 'string') return value;
    expression.lastIndex = 0;
    return value.replace(expression, action === 'replace' ? replacement : '');
}

function keepMatches(value, keepRules) {
    if (typeof value !== 'string') return value;
    const ranges = [];
    for (const { expression } of keepRules) {
        expression.lastIndex = 0;
        const matches = expression.global ? value.matchAll(expression) : [expression.exec(value)];
        for (const match of matches) {
            if (match?.[0]) ranges.push([match.index, match.index + match[0].length]);
        }
    }
    return ranges.length ? mergeRanges(ranges).map(([start, end]) => value.slice(start, end)).join('\n\n') : value;
}

self.onmessage = ({ data }) => {
    if (data.rules) {
        const compiled = data.rules.map(rule => ({ ...rule, expression: new RegExp(rule.pattern, rule.flags) }));
        const keep = compiled.filter(rule => rule.action === 'keep');
        steps = compiled.filter(rule => rule.action !== 'keep').map(rule => value => applyRule(value, rule));
        if (keep.length) steps.unshift(value => keepMatches(value, keep));
        if (Object.keys(data.tags).length) steps.unshift(value => typeof value === 'string' ? applyTagActions(value, data.tags) : value);
        return;
    }
    let { raw, live } = data;
    let preferRaw = false;
    for (const step of steps) {
        const nextRaw = step(raw);
        const nextLive = step(live);
        preferRaw ||= nextRaw !== raw && nextLive === live;
        raw = nextRaw;
        live = nextLive;
    }
    self.postMessage({ raw, live, preferRaw });
};
