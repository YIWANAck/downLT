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
    ...['index.js', 'document.js', 'render.js', 'model.js', 'chatu8.js', 'assets.js', 'style.css']
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
    await page.getByRole('button', { name: '生成 HTML' }).click();
    await page.getByRole('link', { name: '下载 HTML' }).waitFor({ timeout: 12000 });
    const status = await page.getByRole('status').textContent();
    assert.match(status, /32 条消息、9 项媒体/);
    assert.match(status, /3 项媒体未能保存/);
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

    // A second export can be cancelled while waiting for a slow image.
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
    assert.ok(await page.locator('img').evaluateAll(async images => {
        await Promise.all(images.map(img => { img.loading = 'eager'; return img.decode(); }));
        return images.every(img => img.naturalWidth > 0);
    }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(results, 'mobile.png') });
    await writeFile(path.join(results, 'result.txt'), 'PASS: Full chat, server + IndexedDB + live iframe images, selection, ordering, sanitation, cancellation, offline decoding, mobile layout.\n');
    console.log('PASS: full chat, selected cache images, placement, cancellation, offline mobile rendering');
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
