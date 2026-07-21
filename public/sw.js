"use strict";

const CACHE = "codex-remote-v3-artifact-center"; // Supersedes the codex-remote-v1 shell cache.
const SHELL = [
  "./",
  "index.html",
  "panel.html",
  "panel.js",
  "styles.css",
  "app.js",
  "artifact-ui.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/LICENSE",
  "icon.svg",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "manifest.webmanifest",
  "jsqr.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) {
            return caches.match("index.html").then((cached) => cached || response);
          }
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put("index.html", copy));
          return response;
        })
        .catch(() => caches.match("index.html")),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const update = fetch(request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached || update;
    }),
  );
});
