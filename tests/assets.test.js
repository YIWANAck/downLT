import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaUrl, sniffMedia } from '../assets.js';

const base = 'http://127.0.0.1:8000/';

test('only requests local media and explicitly enabled HTTPS external media', () => {
    assert.equal(mediaUrl('user/images/角色/a.png', base), `${base}user/images/%E8%A7%92%E8%89%B2/a.png`);
    assert.equal(mediaUrl('user/images/a.png', `${base}st/`), `${base}st/user/images/a.png`);
    assert.equal(mediaUrl('https://example.com/a.png', base), null);
    assert.equal(mediaUrl('https://example.com/a.png', base, true), 'https://example.com/a.png');
    for (const url of ['//evil.example/a.png', '/api/settings/get', '/user/images/%2e%2e/%2e%2e/api/a', '/user/images/..%2f..%2fapi/a', 'javascript:alert(1)', 'data:image/svg+xml;base64,abcd', 'blob:https://example.com/1']) {
        assert.equal(mediaUrl(url, base), null, url);
    }
});

test('sniffs true media type rather than embedding server login pages or scripts', () => {
    assert.equal(sniffMedia(Uint8Array.of(137,80,78,71,13,10,26,10)), 'image/png');
    assert.equal(sniffMedia(new TextEncoder().encode('RIFF0000WEBP')), 'image/webp');
    assert.equal(sniffMedia(new TextEncoder().encode('<html>Login</html>')), null);
});
