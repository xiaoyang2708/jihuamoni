/* 本地静态服务器。只为在电脑/手机上打开这个工具用，不参与业务逻辑。 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      /* 开发阶段一律不缓存。否则改了 js 刷新还是旧的，很难排查。 */
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  备考节奏已启动');
  console.log('  电脑上打开：  http://localhost:' + PORT);
  console.log('');
  console.log('  想在手机上看，保持同一个 Wi-Fi，用手机浏览器打开：');
  console.log('  ' + localIPs().map(ip => 'http://' + ip + ':' + PORT).join('\n  '));
  console.log('');
  console.log('  关掉这个窗口就是停止。');
  console.log('');
});

function localIPs() {
  const os = require('os');
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(i => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out.length ? out : ['(没有找到局域网地址)'];
}
