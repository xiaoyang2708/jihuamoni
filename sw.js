/* =========================================================================
 * sw.js —— 离线缓存，只为"加到桌面之后能离线打开"
 *
 * 策略是网络优先：在线时永远拿最新的文件，断网了才吃缓存。
 * 这么选是因为这个项目改得勤，缓存优先很容易出现"我明明改了怎么还是旧的"。
 * ========================================================================= */

var CACHE = 'beikao-v6';

var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
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

  /* 网络优先，但最多等 3.5 秒；超过就先吃缓存，网络请求继续在后台跑，
   * 回来后顺手把缓存更新掉。这样 GitHub Pages 慢的时候，第二次打开不会
   * 又卡几十秒。 */
  var network = fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
    }
    return res;
  });
  var timeout = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error('slow')); }, 3500);
  });

  e.respondWith(
    Promise.race([network, timeout]).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        return network;
      }).catch(function () {
        /* 直接输网址进来的时候请求是导航请求，回 index.html 才不会白屏 */
        return req.mode === 'navigate' ? caches.match('./index.html') : Response.error();
      });
    })
  );
});
