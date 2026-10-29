/* sw.js — 离线缓存
 *
 * 策略刻意做得很保守：
 *   - 导航请求（打开页面）：网络优先，离线才回缓存 —— 保证不会因为 Service Worker
 *     把用户锁在旧版本里（这正是「加了 PWA 之后更新不生效」的经典坑）
 *   - 其余资源：缓存优先。所有资源 URL 都带 ?v= 版本串，版本一变就是新 URL，
 *     不存在「缓存串版本」的问题
 *   - 只缓存同源 GET 且 status 为 ok 的响应，404 / 500 不会被写进缓存
 *
 * 缓存名带版本号：改这里就等于让所有客户端换一份缓存。
 */
var CACHE = 'is6-static-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function put(req, res) {
  if (!res || !res.ok) return;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) { put(req, res.clone()); return res; })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) { put(req, res.clone()); return res; });
    })
  );
});
