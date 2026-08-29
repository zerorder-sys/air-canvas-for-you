/**
 * Air Canvas Service Worker
 *
 * Caches:
 *   1. App shell (HTML, CSS, JS) — instant load on repeat visits
 *   2. MediaPipe CDN files — works offline after first load
 *   3. App icons
 *
 * Does NOT cache:
 *   - Camera stream (always live)
 *   - WebSocket connections (real-time)
 */

const CACHE_NAME = 'air-canvas-v1';

// App shell files (served by Vite from /dist)
const APP_SHELL = [
  '/',
  '/index.html',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

// MediaPipe CDN files (loaded in index.html via <script> tags)
const MEDIAPIPE_CDN = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.min.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.min.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.min.js',
  // MediaPipe WASM and model files (loaded dynamically by hands.min.js)
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands_solution_packed_assets_loader.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands_solution_packed_assets.data',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.binarypb',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hand_landmark_full.tflite',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands_solution_simd_wasm_bin.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands_solution_simd_wasm_bin.wasm',
];

// Install: cache app shell and MediaPipe CDN
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching app shell and MediaPipe CDN');
      // Cache app shell first (critical)
      return cache.addAll(APP_SHELL).then(() => {
        // Cache MediaPipe CDN (may fail if offline — that's OK, we retry on activate)
        return Promise.allSettled(
          MEDIAPIPE_CDN.map((url) =>
            cache.add(url).catch((err) => {
              console.warn(`[SW] Failed to cache ${url}:`, err.message);
            })
          )
        );
      });
    })
  );
  // Skip waiting to activate immediately
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log(`[SW] Removing old cache: ${key}`);
            return caches.delete(key);
          })
      );
    })
  );
  // Claim all clients immediately
  self.clients.claim();
});

// Fetch: cache-first for app shell and CDN, network-first for everything else
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip camera/websocket URLs
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;

  // For MediaPipe CDN and app shell: cache-first strategy
  if (
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === location.hostname
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;

        return fetch(request)
          .then((response) => {
            // Don't cache if not successful
            if (!response || response.status !== 200) return response;

            // Clone and cache the response
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });

            return response;
          })
          .catch(() => {
            // Offline and not in cache — return a basic offline page for HTML
            if (request.headers.get('accept')?.includes('text/html')) {
              return new Response(
                '<html><body style="background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center"><div><h1>Air Canvas</h1><p>You are offline. Please connect to the internet to use hand tracking.</p></div></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            }
            return new Response('Offline', { status: 503 });
          });
      })
    );
    return;
  }

  // For everything else: network-first
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
