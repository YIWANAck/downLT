let expressions = [];

function removeMatches(value, expression) {
    if (typeof value !== 'string') return value;
    expression.lastIndex = 0;
    return value.replace(expression, '');
}

self.onmessage = ({ data }) => {
    if (data.rules) {
        expressions = data.rules.map(({ pattern, flags }) => new RegExp(pattern, flags));
        return;
    }
    let { raw, live } = data;
    let preferRaw = false;
    for (const expression of expressions) {
        const nextRaw = removeMatches(raw, expression);
        const nextLive = removeMatches(live, expression);
        preferRaw ||= nextRaw !== raw && nextLive === live;
        raw = nextRaw;
        live = nextLive;
    }
    self.postMessage({ raw, live, preferRaw });
};
