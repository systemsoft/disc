/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * QueryCache Benchmarks
 *
 * Benchmarks LRU cache operations: hits, misses, sets, evictions, and mixed workloads.
 */

/*** UTILITY ------------------------------------------ ***/

import { QueryCache } from "../lib/query-cache.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.bench("cache: hit (populated)", b => {
  const cache = new QueryCache<string>(1000);

  for (let i = 0; i < 1000; i++) {
    cache.set(`query_${i}`, `result_${i}`);
  }

  let idx = 0;
  b.start();

  for (let i = 0; i < 1000; i++) {
    cache.get(`query_${idx++ % 1000}`);
  }

  b.end();
});

Deno.bench("cache: miss", b => {
  const cache = new QueryCache<string>(1000);
  b.start();

  for (let i = 0; i < 1000; i++) {
    cache.get(`query_${i}`);
  }

  b.end();
});

Deno.bench("cache: set (fill)", b => {
  const cache = new QueryCache<string>(1000);
  b.start();

  for (let i = 0; i < 1000; i++) {
    cache.set(`query_${i}`, `result_${i}`);
  }

  b.end();
});

Deno.bench("cache: eviction (overflow)", b => {
  const cache = new QueryCache<string>(100);
  b.start();

  for (let i = 0; i < 500; i++) {
    cache.set(`query_${i}`, `result_${i}`);
  }

  b.end();
});

Deno.bench("cache: mixed hit/miss", b => {
  const cache = new QueryCache<string>(500);

  for (let i = 0; i < 250; i++) {
    cache.set(`query_${i}`, `result_${i}`);
  }

  b.start();

  for (let i = 0; i < 500; i++) {
    cache.get(`query_${i}`);
  }

  b.end();
});
