/* =========================================================================
 * sw.js —— 离线缓存，只为"加到桌面之后能离线打开"
 *
 * 策略是网络优先：在线时永远拿最新的文件，断网了才吃缓存。
 * 这么选是因为这个项目改得勤，缓存优先很容易出现"我明明改了怎么还是旧的"。
 * ========================================================================= */

var CACHE = 'beikao-v2';

var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './fonts/noto-sans-sc-subset.woff2',
  './js/config.js',
  './js/engine.js',
  './js/stats.js',
  './js/archive.js',
  './js/store.js',
  './js/demo.js',
  './js/app.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        /* 单个文件失败不影响整体——比如某次发布把 demo.js 删了 */
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        /* 直接输网址进来的时候请求是导航请求，回 index.html 才不会白屏 */
        return hit || (req.mode === 'navigate' ? caches.match('./index.html') : null);
      }).then(function (r) {
        return r || Response.error();
      });
    })
  );
});
