// Pair tags before editing so nested blocks with the same name are handled together.
export function tagBlocks(text) {
    const tokens = /<!--[\s\S]*?-->|(`{3,}|~{3,})[\s\S]*?\1|(`+)[^\n]*?\2|<(\/?)([\p{L}][\p{L}\p{N}_:-]*)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>|\[(\/?)([\p{L}][\p{L}\p{N}_:-]*)\]/gu;
    const opened = new Map();
    const blocks = [];
    for (const match of text.matchAll(tokens)) {
        const [, , , angleClose, angleName, squareClose, squareName] = match;
        const name = (angleName ?? squareName)?.toLowerCase();
        if (!name || match[0].endsWith('/>')) continue;
        const tag = angleName ? `<${name}>` : `[${name}]`;
        const end = match.index + match[0].length;
        if (angleClose || squareClose) {
            const start = opened.get(tag)?.pop();
            if (start) blocks.push({ tag, ...start, closeStart: match.index, end });
        } else {
            if (!opened.has(tag)) opened.set(tag, []);
            opened.get(tag).push({ start: match.index, openEnd: end });
        }
    }
    return blocks;
}

export function mergeRanges(ranges) {
    const merged = [];
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
        const previous = merged.at(-1);
        if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

export function applyTagActions(text, actions) {
    const blocks = tagBlocks(text);
    const keep = mergeRanges(blocks.filter(block => actions[block.tag] === 'keep')
        .map(block => [block.openEnd, block.closeStart]));
    if (keep.length) text = keep.map(([start, end]) => text.slice(start, end)).join('\n\n');

    const edits = [];
    for (const block of keep.length ? tagBlocks(text) : blocks) {
        if (actions[block.tag] === 'remove') edits.push([block.start, block.end, '\n\n']);
        if (actions[block.tag] === 'unwrap') edits.push([block.start, block.openEnd, ''], [block.closeStart, block.end, '']);
    }
    // A deleted outer block takes priority over the edits on its nested tags.
    const removals = mergeRanges(edits.filter(edit => edit[2]).map(([start, end]) => [start, end]));
    const changes = edits.filter(([start, end, replacement]) => !replacement && !removals.some(([from, to]) => from < end && start < to));
    changes.push(...removals.map(([start, end]) => [start, end, '\n\n']));
    for (const [start, end, replacement] of changes.sort((a, b) => b[0] - a[0])) {
        text = text.slice(0, start) + replacement + text.slice(end);
    }
    return text;
}
