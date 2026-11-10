/* 可选的真实浏览器检查：先用 --remote-debugging-port=9223 启动本地 Edge，
 * 再运行 node tests/browser.qa.js。无需第三方依赖。 */
const fs = require('fs');
const path = require('path');

async function main() {
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
  const page = pages.find(p => p.type === 'page' && /index\.html/.test(p.url));
  if (!page) throw new Error('找不到本地页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`localStorage.removeItem('is6calc.v1'); localStorage.removeItem('is6calc.v1.bak'); localStorage.removeItem('is6calc.tab')`);
  await send('Page.reload', { ignoreCache: true });
  await delay(1200);
  const before = await evaluate(`({
    width: innerWidth,
    contentWidth: document.documentElement.scrollWidth,
    nav: (() => { const r = document.getElementById('mobileQuickNav').getBoundingClientRect(); return [r.left, r.right]; })(),
    buttons: [...document.querySelectorAll('#mobileQuickNav button')].map(x => x.getBoundingClientRect().right)
  })`);
  if (before.width !== 390 || before.contentWidth > 390 || before.nav[1] > 390 || before.buttons.some(x => x > 390)) {
    throw new Error('手机视口横向溢出：' + JSON.stringify(before));
  }

  await evaluate(`document.querySelector('#verdict .primary').click()`);
  await delay(300);
  const after = await evaluate(`({
    preview: document.getElementById('workspacePreview').innerText,
    stats: document.querySelectorAll('.preview-stat').length,
    sources: document.querySelectorAll('.preview-sources li').length,
    contentWidth: document.documentElement.scrollWidth
  })`);
  if (after.stats !== 6 || after.sources < 1 || after.contentWidth > 390) {
    throw new Error('示例结果未完整呈现：' + JSON.stringify(after));
  }
  await evaluate(`document.getElementById('quickResults').click()`);
  await delay(900);
  const visible = await evaluate(`({ active: document.getElementById('tabSquad').getAttribute('aria-selected'), top: document.getElementById('workspacePreview').getBoundingClientRect().top, scrollY, scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight })`);
  if (visible.active !== 'true' || visible.top < 0 || visible.top > 650) throw new Error('快捷结果入口没有滚到主工作区：' + JSON.stringify(visible));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const out = path.join(__dirname, '..', 'review', 'ui-mobile-demo.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ before, stats: after.stats, sources: after.sources, visible, screenshot: out }, null, 2));
  ws.close();
}

main().catch(err => { console.error(err.stack || err); process.exit(1); });
