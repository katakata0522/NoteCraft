'use strict';

// NoteCraft service worker entrypoint.
// Split into classic worker scripts for maintainability; all parts share the same WorkerGlobalScope.
importScripts(
  '../shared/core.js',
  'service-worker.part1.js',
  'service-worker.part2.js',
  'service-worker.part3.js',
  'service-worker.part4.js',
  'service-worker.part5.js'
);
