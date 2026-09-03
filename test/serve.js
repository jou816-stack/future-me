'use strict';
// 測試用：把 src/renderer 用 http 端出來，方便在瀏覽器裡預覽版面（會缺 window.api，需自行 stub）
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'src', 'renderer');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname === '/') p = path.join(root, 'index.html');
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(8765, () => console.log('renderer preview on http://localhost:8765'));
