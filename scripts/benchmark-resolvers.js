"use strict";
/**
 * Benchmarks the 3 audio-resolving backends (see src/resolvers.js) against
 * each other on real YouTube URLs, so you can see for yourself - on YOUR
 * network/region, since this varies a lot by location and by which Piped
 * instances are healthy right now - which backend is actually fastest and
 * most reliable, instead of guessing.
 *
 * Usage:
 *   npm run benchmark-resolvers
 *   npm run benchmark-resolvers -- --runs 5
 *   npm run benchmark-resolvers -- <youtube-url-1> <youtube-url-2> ...
 *
 * Options:
 *   --runs N   how many times to test each URL against each backend (default 3)
 *   --json     also write a machine-readable report to benchmark-results.json
 *
 * What it measures per backend:
 *   - success rate (successful resolves / total attempts)
 *   - average / min / max latency of SUCCESSFUL attempts only (a fast
 *     failure shouldn't make a backend look "fast" - it's not usable)
 *
 * This does NOT touch mpv/playback at all - it only exercises the same
 * resolve step used right before playback (getting a direct stream URL),
 * so it's safe to run anytime without disturbing anything currently playing.
 */
const path = require("path");
process.chdir(path.join(__dirname, ".."));

const resolvers = require("../src/resolvers");

const DEFAULT_TEST_URLS = [
  // A handful of long-lived, non-region-locked public videos. Feel free to
  // pass your own URLs as CLI args instead - your own typical request mix
  // (short clips vs official MVs vs live streams etc.) is the most
  // representative benchmark for YOUR use case.
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Rick Astley - Never Gonna Give You Up
  "https://www.youtube.com/watch?v=jNQXAC9IVRw", // Me at the zoo (first YouTube video ever)
  "https://www.youtube.com/watch?v=9bZkp7q19f0", // PSY - GANGNAM STYLE
];

const BACKEND_FNS = {
  ytdlp: resolvers.resolveViaYtdlp,
  "play-dl": resolvers.resolveViaPlayDl,
  piped: resolvers.resolveViaPiped,
};

function parseArgs(argv) {
  const args = { runs: 3, json: false, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") {
      args.runs = parseInt(argv[++i], 10) || 3;
    } else if (argv[i] === "--json") {
      args.json = true;
    } else if (!argv[i].startsWith("--")) {
      args.urls.push(argv[i]);
    }
  }
  if (!args.urls.length) args.urls = DEFAULT_TEST_URLS;
  return args;
}

function fmtMs(ms) {
  return `${ms.toFixed(0)}ms`;
}

function stats(samples) {
  if (!samples.length) return null;
  const sum = samples.reduce((a, b) => a + b, 0);
  return { avg: sum / samples.length, min: Math.min(...samples), max: Math.max(...samples) };
}

async function benchmarkBackend(name, fn, urls, runs) {
  const successes = [];
  const failures = [];
  let attempts = 0;

  for (const url of urls) {
    for (let r = 0; r < runs; r++) {
      attempts++;
      const t0 = Date.now();
      try {
        await fn(url);
        const ms = Date.now() - t0;
        successes.push(ms);
        process.stdout.write(".");
      } catch (e) {
        failures.push({ url, error: e.message });
        process.stdout.write("x");
      }
    }
  }
  process.stdout.write("\n");

  const s = stats(successes);
  return {
    backend: name,
    attempts,
    successCount: successes.length,
    successRate: attempts ? successes.length / attempts : 0,
    avgMs: s ? s.avg : null,
    minMs: s ? s.min : null,
    maxMs: s ? s.max : null,
    failures,
  };
}

function printReport(results) {
  console.log("\n" + "=".repeat(64));
  console.log("  HASIL BENCHMARK RESOLVER");
  console.log("=".repeat(64));

  // Rank by: success rate first (a fast-but-unreliable backend isn't
  // actually "better"), then by average latency among successes.
  const ranked = [...results].sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    return (a.avgMs || Infinity) - (b.avgMs || Infinity);
  });

  const rows = ranked.map((r, i) => ({
    "#": i + 1,
    backend: r.backend,
    "success rate": `${(r.successRate * 100).toFixed(0)}% (${r.successCount}/${r.attempts})`,
    "avg latency": r.avgMs != null ? fmtMs(r.avgMs) : "-",
    "min/max": r.avgMs != null ? `${fmtMs(r.minMs)} / ${fmtMs(r.maxMs)}` : "-",
  }));
  console.table(rows);

  const winner = ranked[0];
  if (winner && winner.successCount > 0) {
    console.log(`\n>> Paling direkomendasikan saat ini: "${winner.backend}" (${(winner.successRate * 100).toFixed(0)}% berhasil, rata-rata ${fmtMs(winner.avgMs)})`);
    console.log(`   Kalau mau pakai urutan ini, set di config.json:\n   "resolver_order": ${JSON.stringify(ranked.filter((r) => r.successCount > 0).map((r) => r.backend))}`);
  } else {
    console.log("\n>> Semua backend gagal total di run ini - cek koneksi internet kamu, atau coba lagi (Piped instance publik kadang sedang down).");
  }

  for (const r of ranked) {
    if (r.failures.length) {
      console.log(`\n[${r.backend}] contoh kegagalan:`);
      for (const f of r.failures.slice(0, 3)) {
        console.log(`   - ${f.url}: ${f.error}`);
      }
    }
  }
  console.log("\nCatatan: hasil ini tergantung koneksi internet & lokasi kamu saat ini, dan Piped");
  console.log("pakai instance publik pihak ketiga yang bisa naik-turun kapan aja - jalanin ulang");
  console.log("beberapa kali di jam yang berbeda kalau mau angka yang lebih stabil.\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Benchmarking ${Object.keys(BACKEND_FNS).length} backend x ${args.urls.length} URL x ${args.runs} run = ${Object.keys(BACKEND_FNS).length * args.urls.length * args.runs} percobaan total.\n`);

  const results = [];
  for (const [name, fn] of Object.entries(BACKEND_FNS)) {
    console.log(`--- ${name} ---`);
    results.push(await benchmarkBackend(name, fn, args.urls, args.runs));
  }

  printReport(results);

  if (args.json) {
    const fs = require("fs");
    const outPath = path.join(__dirname, "..", "benchmark-results.json");
    fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), urls: args.urls, runs: args.runs, results }, null, 2));
    console.log(`Report JSON ditulis ke: ${outPath}`);
  }
}

main().catch((e) => {
  console.error("Benchmark gagal jalan:", e);
  process.exit(1);
});
