'use strict';
// 測試用：透過 Chrome DevTools Protocol 對執行中的 App 下 JS、截圖
// 用法：node --experimental-websocket test/cdp.js shot out.png [pageIndex]
//       node --experimental-websocket test/cdp.js eval "expression" [pageIndex]
const fs = require('fs');
const PORT = process.env.CDP_PORT || 9333;

async function main() {
  const [cmd, arg, pageIdxArg] = process.argv.slice(2);
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((p) => p.type === 'page');
  const page = pages[Number(pageIdxArg || 0)];
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved', arg, 'url:', page.url);
  } else if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails, null, 1));
    else console.log(JSON.stringify(r.result.result.value));
  } else if (cmd === 'pages') {
    console.log(pages.map((p, i) => `${i}: ${p.url}`).join('\n'));
  }
  ws.close();
  process.exit(0);
}
setTimeout(() => { console.error('cdp timeout'); process.exit(2); }, 10000);
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
