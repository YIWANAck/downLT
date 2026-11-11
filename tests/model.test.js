import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5, normalizeTag, selectImage, snapshotChat, getPlacements, splitTags } from '../model.js';

test('MD5 agrees with UTF-8 standard vectors including Chinese and emoji', () => {
    for (const value of ['', 'a', 'abc', 'a'.repeat(1000), '女孩，雨夜🌙']) {
        assert.equal(md5(value), createHash('md5').update(value).digest('hex'));
    }
});

test('normalizes prompt text exactly as chatu8 without changing ordinary spacing', () => {
    assert.equal(normalizeTag('  女孩，\n雨夜；《细节》：好\r  '), '女孩,雨夜;<细节>:好');
});

test('selected image uses combined sorted timeline and active storage index', () => {
    const server = { index: 1, images: [{ uuid: 's1', date: 20 }, { uuid: 's2', date: 40 }] };
    const db = { index: 2, images: [{ uuid: 'd1', date: 10 }, { uuid: 'd2', date: 30 }] };
    assert.equal(selectImage(server, db, true).uuid, 's1');
    assert.equal(selectImage(server, db, false).uuid, 'd2');
    assert.equal(selectImage(null, { index: 99, images: db.images }, false).uuid, 'd2');
    assert.equal(selectImage(null, null, true), null);
});

test('snapshot includes messages absent from DOM and excludes settings and alternative swipes', () => {
    const context = { chat: Array.from({ length: 80 }, (_, i) => ({ name: '角色', mes: `第${i}条`, swipes: ['secret'] })), chatId: '测试', extensionSettings: { api_key: 'secret' }, chatMetadata: {} };
    const result = snapshotChat(context);
    assert.equal(result.messages.length, 80);
    assert.equal(result.messages[79].mes, '第79条');
    assert.ok(!JSON.stringify(result).includes('secret'));
    result.messages[0].mes = 'changed';
    assert.equal(context.chat[0].mes, '第0条');
});

test('uses only selected swipe placements, with metadata key fallback', () => {
    const message = { swipe_id: 1, extra: { images: { 0: [{ tag: 'wrong' }], 1: [{ tag: 'right', endIndex: 3 }] } } };
    assert.equal(getPlacements(message, {}, 'text')[0].tag, 'right');
    assert.deepEqual(getPlacements({ extra: {} }, { '短文': [{ tag: 'fallback' }] }, '短文'), [{ tag: 'fallback' }]);
});

test('custom tag delimiters are treated literally and Markdown links remain intact', () => {
    const matches = splitTags('前文 image###girl### 后文 [网页](https://example.com)', 'image###', '###');
    assert.deepEqual(matches, [{ start: 3, end: 18, tag: 'girl' }]);
    assert.deepEqual(splitTags('正文 【图:女孩】', '【图:', '】'), [{ start: 3, end: 9, tag: '女孩' }]);
});
