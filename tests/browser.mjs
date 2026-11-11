import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const prefix = '/scripts/extensions/third-party/st-html-export/';
const staticFiles = new Map([
    ['/', ['tests/fixture.html', 'text/html; charset=utf-8']],
    ['/fixture.js', ['tests/fixture.js', 'text/javascript; charset=utf-8']],
    ['/dompurify.mjs', ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript']],
    ...['index.js', 'document.js', 'render.js', 'model.js', 'chatu8.js', 'assets.js', 'regex-filter.js', 'regex-worker.js', 'style.css']
        .map(file => [prefix + file, [file, file.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8']]),
]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ3sAAAAASUVORK5CYII=', 'base64');
const requests = [];
const server = createServer(async (req, res) => {
    requests.push(req.url);
    try {
        if (req.url === '/lib.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end('export { default as DOMPurify } from "/dompurify.mjs";');
        if (req.url === '/user/images/test.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
        if (req.url === '/user/images/slow.png') {
            const timer = setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(png), 3000);
            res.on('close', () => clearTimeout(timer));
            return;
        }
        const entry = staticFiles.get(req.url);
        if (!entry) return res.writeHead(404).end();
        const data = await readFile(path.join(root, entry[0]));
        res.writeHead(200, { 'content-type': entry[1] }).end(data);
    } catch { res.writeHead(500).end(); }
});

const candidates = [process.env.STHE_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* try next browser */ }
}

const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
let browser;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch({ executablePath, headless: true });
    const session = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    const page = await session.newPage();
    const pageErrors = [];
    const remote = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (request.url().startsWith('https:')) remote.push(request.url()); });
    await page.goto(url);
    await page.waitForFunction(() => globalThis.fixtureReady === true, null, { timeout: 12000 });
    const expected = await page.evaluate(() => [testValues.urlA, testValues.urlB, testValues.urlC]);
    await page.locator('#sthe-export-menu').click();
    const includeUser = page.getByRole('checkbox', { name: '包含我的消息' });
    assert.equal(await includeUser.isChecked(), true);
    await page.getByRole('button', { name: '生成 HTML' }).click();
    await page.getByRole('link', { name: '下载 HTML' }).waitFor({ timeout: 12000 });
    const status = await page.getByRole('status').textContent();
    assert.match(status, /32 条消息、9 项媒体/);
    assert.match(status, /3 项媒体未能保存/);
    assert.match(status, /找不到生图缓存/);
    assert.match(status, /未开启外链图片导出/);
    assert.doesNotMatch(status, /已达单文件图片大小上限/);
    assert.match(status, /1 项插图移至/);
    assert.equal(await page.evaluate(() => JSON.stringify(testValues.context.chat) === testValues.chatBefore), true);
    assert.equal(requests.filter(request => request === '/user/images/test.png').length, 1);
    assert.equal(requests.includes('/api/settings/get'), false);
    assert.deepEqual(remote, []);

    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 HTML' }).click();
    const download = await downloading;
    assert.match(download.suggestedFilename(), /\.html$/);
    const htmlFile = path.join(results, 'archive.html');
    await download.saveAs(htmlFile);
    const text = await readFile(htmlFile, 'utf8');
    assert.ok(!text.includes('SECRET_TEST_KEY'));
    assert.ok(!text.includes('external.invalid'));
    assert.ok(!text.includes('blob:'));
    assert.ok(!text.includes('/user/images/test.png'));
    assert.ok(text.includes('普通图片附件'));
    assert.ok(text.includes('原文思考') && text.includes('页面选项'));

    await includeUser.uncheck();
    await page.getByRole('button', { name: '生成 HTML' }).click();
    const filteredLink = page.getByRole('link', { name: '下载 HTML' });
    await filteredLink.waitFor({ timeout: 12000 });
    assert.match(await page.getByRole('status').textContent(), /31 条消息、8 项媒体/);
    const filtered = await filteredLink.evaluate(async link => (await fetch(link.href)).text());
    assert.ok(!filtered.includes('普通图片附件'));
    assert.ok(filtered.includes('嵌入状态栏'));
    assert.equal(await page.evaluate(() => JSON.stringify(testValues.context.chat) === testValues.chatBefore), true);
    await includeUser.check();

    const regexToggle = page.getByRole('checkbox', { name: '用正则移除导出内容' });
    assert.equal(await regexToggle.isChecked(), false);
    await regexToggle.check();
    const editor = page.getByRole('textbox', { name: '要移除的内容' });
    const exampleRules = await editor.inputValue();
    await editor.fill('/[/g');
    await page.getByRole('button', { name: '生成 HTML' }).click();
    assert.match(await page.getByRole('status').textContent(), /第 1 行的正则表达式或标志无效/);
    await editor.fill(exampleRules + '\n/第 13 条消息/g');
    await page.getByRole('button', { name: '生成 HTML' }).click();
    await filteredLink.waitFor({ timeout: 12000 });
    const cleaned = await filteredLink.evaluate(async link => (await fetch(link.href)).text());
    for (const removed of ['原文思考', '第二行思考', '原文选项', '页面选项', '第 13 条消息']) {
        assert.ok(!cleaned.includes(removed), removed);
    }
    assert.ok(cleaned.includes('前文') && cleaned.includes('嵌入状态栏'));
    assert.ok(cleaned.includes(expected[0]) && cleaned.includes(expected[1]));
    assert.match(await page.getByRole('status').textContent(), /32 条消息、9 项媒体/);
    assert.equal(await page.evaluate(() => JSON.stringify(testValues.context.chat) === testValues.chatBefore), true);
    await regexToggle.uncheck();

    // An export can be cancelled while waiting for a slow image.
    await page.evaluate(() => {
        testValues.context.chat[0].extra = { media: [{ type: 'image', url: '/user/images/slow.png' }] };
    });
    await page.getByRole('button', { name: '生成 HTML' }).click();
    await page.getByRole('button', { name: '取消导出' }).click();
    await page.waitForFunction(() => document.querySelector('.sthe-status').textContent === '已取消导出。');
    assert.equal(await page.getByRole('link', { name: '下载 HTML' }).count(), 0);

    await session.setOffline(true);
    await page.goto(pathToFileURL(htmlFile).href);
    assert.equal(await page.locator('.message').count(), 32);
    assert.equal(await page.locator('.message').first().locator('.body').innerText(), '第一条，没出现在酒馆页面。');
    assert.equal(await page.locator('.message').nth(1).locator('strong').innerText(), '前文');
    assert.equal(await page.locator('.message').nth(1).locator('img').getAttribute('src'), expected[1]);
    assert.equal(await page.locator('.message').nth(2).locator('p').first().locator('img').count(), 1);
    assert.equal(await page.locator('.message').nth(3).locator('img').getAttribute('src'), expected[2]);
    assert.equal(await page.locator('.message').nth(10).locator('img').first().getAttribute('src'), expected[1]);
    assert.equal(await page.locator('.message').nth(10).locator('img').last().getAttribute('src'), expected[2]);
    assert.equal(await page.locator('.message').nth(11).locator('img').getAttribute('src'), expected[2]);
    assert.equal(await page.locator('.message').nth(31).locator('img').getAttribute('src'), expected[0]);
    assert.match(await page.locator('.message').nth(31).locator('.body').innerText(), /嵌入状态栏/);
    assert.equal(await page.locator('script,iframe,svg,[onclick],[onerror]').count(), 0);
    assert.equal(await page.getByText('危险链接').getAttribute('href'), null);
    assert.equal(await page.locator('pre code').textContent(), 'image###code###');
    assert.equal(await page.locator('.media-missing').count(), 3);
    assert.equal(await page.locator('.media-missing').filter({ hasText: '找不到生图缓存' }).count(), 1);
    assert.ok(await page.locator('img').evaluateAll(async images => {
        await Promise.all(images.map(img => { img.loading = 'eager'; return img.decode(); }));
        return images.every(img => img.naturalWidth > 0);
    }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(results, 'mobile.png') });

    // Lower the media budget in a separate page to exercise real downloads without large test files.
    await session.setOffline(false);
    const splitPage = await session.newPage();
    const assetsSource = await readFile(path.join(root, 'assets.js'), 'utf8');
    await splitPage.route(`**${prefix}assets.js`, route => route.fulfill({
        contentType: 'text/javascript',
        body: assetsSource.replace('MAX_EMBEDDED = 96 * MiB', 'MAX_EMBEDDED = 550'),
    }));
    await splitPage.goto(url);
    await splitPage.waitForFunction(() => globalThis.fixtureReady === true, null, { timeout: 12000 });
    await splitPage.evaluate(() => { testValues.context.chatId = '分段续导测试'; });
    await splitPage.locator('#sthe-export-menu').click();
    await splitPage.getByRole('checkbox', { name: /自动分段导出/ }).check();
    await splitPage.getByRole('button', { name: '生成 HTML' }).click();
    const combinedMessages = [];
    let savedMedia = 0;
    let partCount = 0;
    for (let part = 1; part <= 10; part++) {
        const link = splitPage.getByRole('link', { name: `下载第 ${part} 段` });
        await link.waitFor({ timeout: 12000 });
        const archive = await link.evaluate(async anchor => {
            const html = await (await fetch(anchor.href)).text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            return {
                messages: [...doc.querySelectorAll('.message .body')].map(node => node.textContent),
                media: doc.querySelectorAll('.message img, .message video').length,
                hitLimit: html.includes('已达到单文件图片大小上限'),
            };
        });
        assert.equal(archive.hitLimit, false);
        combinedMessages.push(...archive.messages);
        savedMedia += archive.media;
        partCount = part;
        const more = splitPage.getByRole('button', { name: '生成下一段' });
        if (await more.isVisible()) assert.equal(await more.isEnabled(), false);
        const pending = splitPage.waitForEvent('download');
        await link.click();
        assert.ok((await pending).suggestedFilename().endsWith(`-${String(part).padStart(3, '0')}.html`));
        assert.ok(await splitPage.evaluate(end => Object.keys(localStorage).some(key => (
            key.startsWith('st-html-export.progress.') && JSON.parse(localStorage.getItem(key)).end === end
        )), combinedMessages.length));
        if (!await more.isVisible()) break;
        await more.click();
    }
    assert.ok(partCount > 1);
    assert.equal(combinedMessages.length, 32);
    assert.match(combinedMessages[1], /前文.*后文/s);
    assert.match(combinedMessages[31], /嵌入状态栏/);
    assert.equal(savedMedia, 9);

    const wholeMessage = await splitPage.evaluate(async ({ modulePrefix }) => {
        const { buildArchiveParts } = await import(`${modulePrefix}document.js`);
        const { snapshotChat } = await import(`${modulePrefix}model.js`);
        const { DOMPurify } = await import('/lib.js');
        const source = testValues.urlA;
        const chat = [3, 4].map(count => ({ name: '旅人', mes: `<p>${count} 张图</p>` + `<img src="${source}">`.repeat(count) }));
        const results = [];
        for await (const part of buildArchiveParts(snapshotChat({ chat }), {
            format: raw => raw, sanitize: (html, config) => DOMPurify.sanitize(html, config),
            split: true, maxEmbedded: source.length * 4,
        })) {
            results.push([part.count, part.stats.embedded, part.stats.missing]);
        }
        return results;
    }, { modulePrefix: prefix });
    assert.deepEqual(wholeMessage, [[1, 3, 0], [1, 4, 0]]);

    await splitPage.evaluate(() => {
        testValues.context.chat.push(
            { name: '我', mes: '导出之后我继续聊天了。', is_user: true },
            { name: '旅人', mes: '这是新增回复。' },
        );
    });
    await splitPage.getByRole('checkbox', { name: /自动分段导出/ }).uncheck();
    const resume = splitPage.getByRole('checkbox', { name: '只导出上次之后的消息' });
    await resume.check();
    assert.match(await splitPage.locator('.sthe-resume-hint').textContent(), /第 32 条/);
    const generate = splitPage.getByRole('button', { name: '生成 HTML' });
    const resumedLink = splitPage.getByRole('link', { name: '下载 HTML' });
    await generate.click();
    await resumedLink.waitFor({ timeout: 12000 });
    assert.match(await resumedLink.getAttribute('download'), /消息33-34\.html$/);
    const resumed = await resumedLink.evaluate(async link => (await fetch(link.href)).text());
    assert.ok(resumed.includes('这是新增回复。') && resumed.includes('导出之后我继续聊天了。'));
    assert.ok(!resumed.includes('嵌入状态栏'));
    const resumedDownload = splitPage.waitForEvent('download');
    await resumedLink.click();
    await resumedDownload;
    await generate.click();
    assert.match(await splitPage.getByRole('status').textContent(), /没有符合当前选项的新消息/);

    await splitPage.evaluate(() => { testValues.context.chat[0].mes = '已编辑的旧消息'; });
    await generate.click();
    assert.match(await splitPage.getByRole('status').textContent(), /上次导出前的消息有变动/);
    assert.equal(await resumedLink.count(), 0);
    await splitPage.getByRole('spinbutton', { name: '从第几条消息开始' }).fill('34');
    await generate.click();
    await resumedLink.waitFor({ timeout: 12000 });
    assert.match(await resumedLink.getAttribute('download'), /消息34-34\.html$/);
    assert.match(await splitPage.getByRole('status').textContent(), /本文件有 1 条消息/);
    await writeFile(path.join(results, 'result.txt'), 'PASS: Full chat, server + IndexedDB + live iframe images, selection, ordering, sanitation, cancellation, offline decoding, mobile layout.\n');
    console.log(`PASS: full chat, selected cache images, placement, cancellation, offline mobile rendering, ${partCount} split downloads, incremental export, regex filtering`);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
