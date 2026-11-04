#!/usr/bin/env node
/*
  build-photo-index.js — builds photos.json, the gallery index for the photo search. Node 18+, no dependencies.

    node tools/build-photo-index.js [--out FILE] [--bootstrap] [--cache DIR] [--concurrency N] [--limit N]
                                    [--reparse] [--refetch] [--force]

  1. Walks the site's gallery feed (/api/lazy/load, the backend of the "Load More" button on /photos/archives)
     from newest to oldest: slug, title, date, thumbnail and description of every gallery (~3,750, from 2008),
     plus the cards on the /photos listing pages (a few galleries appear there but not in the feed).
  2. Fetches each gallery page it has not read before for its tags, photo count and captions, and keeps the
     people named in the captions (src/photo-index.js extractPeople). Only new galleries cost a page fetch, so
     an hourly run reads one feed walk and the listing pages (~45 requests) plus a page per new gallery.
  3. Merges into the existing --out file: galleries that drop out of the feed are kept, and a gallery's text
     follows the feed. When nothing changed the file is left untouched (same bytes, same "generated"), so a
     scheduled job commits nothing.

  --out FILE       index to merge into and write (default: photos.json next to this repo's videos.json)
  --bootstrap      allow --out not to exist yet (the first build). Without it a missing index is an error, so a
                   misconfigured job cannot quietly re-crawl all ~3,750 gallery pages every run.
  --cache DIR      keep each gallery page's parsed tags/captions in DIR/<slug>.json, so a change to the people
                   rules can be re-run without fetching ~1.7 GB of pages again
  --concurrency N  gallery pages fetched at once (default 4)
  --limit N        only the N newest galleries are walked and updated; the rest of the index is kept as it is
  --reparse        derive every gallery's tags and people again (from --cache where it has the page; otherwise
                   the page is fetched). The feed is still walked.
  --refetch        read every gallery page again (ignores what --cache holds)
  --force          write even when the feed returned far fewer galleries than the existing index holds

  A gallery page that cannot be read keeps what the index already knew about it (or, if new, is written without
  tags/people and retried next run); exit code 2 reports that some pages failed. The parsing rules live in
  src/photo-index.js, which the widget also runs on the feed at page load, so the builder and the live merge
  can never disagree about a card.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const P = require("../src/photo-index.js");

const ORIGIN = "https://www.panthers.com";
const UA = "Mozilla/5.0 (compatible; panthers-photo-index/1.0)";
const RETRIES = 3;
const USAGE = "usage: node tools/build-photo-index.js [--out FILE] [--bootstrap] [--cache DIR] [--concurrency N] " +
              "[--limit N] [--reparse] [--refetch] [--force]   (see the comment at the top of this file)";

const args = parseArgs(process.argv.slice(2));
const OUT = path.resolve(args.out || path.join(__dirname, "..", "photos.json"));
const CACHE = args.cache ? path.resolve(args.cache) : "";
const CONCURRENCY = Math.max(1, Math.min(8, positiveInt("concurrency") || 4));
const LIMIT = positiveInt("limit");
const REREAD = !!(args.reparse || args.refetch);

function parseArgs(argv) {
  const out = {}, flags = ["bootstrap", "reparse", "refetch", "force"], values = ["out", "cache", "concurrency", "limit"];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") { console.log(USAGE); process.exit(0); }
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (m && flags.includes(m[1]) && m[2] === undefined) { out[m[1]] = true; continue; }
    if (!m || !values.includes(m[1])) fail(`unknown argument ${argv[i]}\n${USAGE}`);
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    if (!out[m[1]]) fail(`--${m[1]} needs a value`);
  }
  return out;
}

function positiveInt(name) {
  if (args[name] === undefined) return 0;
  if (!/^[1-9]\d*$/.test(args[name])) fail(`--${name} must be a positive whole number, not "${args[name]}"`);
  return +args[name];
}

function fail(msg) {
  console.error("build-photo-index: " + msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
      last = new Error("HTTP " + r.status);
      if (r.status === 404) break;
    } catch (e) { last = e; }
    await sleep(1000 * attempt * attempt);
  }
  throw last;
}

// ── 1. Feed + listing pages ─────────────────────────────────────────────────────────────────────
async function walkFeed() {
  const cards = [], seen = new Set();
  let skip = 0;
  for (let page = 0; page < 1000; page++) {
    const html = await get(ORIGIN + P.feedUrl(skip, P.FEED_MAX));
    const got = P.parseCards(html);
    for (const c of got) if (!seen.has(c.slug)) { seen.add(c.slug); cards.push(c); }
    if (LIMIT && cards.length >= LIMIT) return cards.slice(0, LIMIT);
    if (!got.length || !P.hasNextPage(html)) return cards;
    // Advance by what the page really held: if the site ever lowers its page-size cap again, the walk stays
    // complete (just slower) instead of silently skipping galleries.
    if (got.length < P.FEED_MAX) console.warn(`  feed page at skip=${skip} held ${got.length} of ${P.FEED_MAX} requested`);
    skip += got.length;
    await sleep(200);
  }
  fail("feed did not end after 1000 pages");
}

// Cards on /photos and its category pages that the feed does not list. A listing page that fails is skipped.
async function listingCards(known) {
  const extra = [];
  for (const slug of P.LISTINGS) {
    let html = "";
    try { html = await get(ORIGIN + "/photos/" + slug); } catch (e) { console.warn(`  /photos/${slug}: ${e.message} (skipped)`); continue; }
    for (const c of P.parseCards(html)) if (!known.has(c.slug)) { known.add(c.slug); extra.push(c); }
  }
  return extra;
}

// ── 2. Gallery pages ────────────────────────────────────────────────────────────────────────────
function cachePath(slug) { return path.join(CACHE, slug.replace(/[^A-Za-z0-9_-]/g, "_") + ".json"); }

async function readGallery(slug) {
  if (CACHE && !args.refetch && fs.existsSync(cachePath(slug))) {
    try {
      const page = JSON.parse(fs.readFileSync(cachePath(slug), "utf8"));
      // The cache holds parseGalleryPage's output; tags and desc are filtered again so a rule change applies.
      // An entry without photos is not a gallery read (see below) and is fetched again.
      if (page && page.n > 0) {
        page.tags = P.cleanTags(page.tags);
        page.desc = P.galleryDesc(page.desc || "");
        return page;
      }
    } catch (e) { /* refetch below */ }
  }
  const page = P.parseGalleryPage(await get(ORIGIN + "/photos/" + encodeURI(slug)));
  // A missing gallery redirects to /photos/ (HTTP 200); an error or maintenance page is a 200 too. A page with
  // no photos is a failed read: it must not overwrite what the index knows, nor be cached.
  if (!page.n) throw new Error("not a gallery page (no photos)");
  if (CACHE) fs.writeFileSync(cachePath(slug), JSON.stringify(page));
  return page;
}

async function pool(items, n, fn) {
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ── 3. Merge + write ────────────────────────────────────────────────────────────────────────────
function loadExisting() {
  if (!fs.existsSync(OUT)) {
    if (!args.bootstrap) fail(`${OUT} does not exist. Pass --bootstrap for a first build, or --out an existing index.`);
    return { map: new Map(), galleries: [], generated: "" };
  }
  let json;
  try { json = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { fail(`${OUT} is not valid JSON: ${e.message}`); }
  if (!json || !Array.isArray(json.galleries)) fail(`${OUT} is not a photo index (no "galleries" array)`);
  const galleries = json.galleries.filter((g) => g && g.slug);
  return { map: new Map(galleries.map((g) => [g.slug, g])), galleries, generated: json.generated || "" };
}

function compact(g) {
  const o = { slug: g.slug, title: g.title };
  if (g.date) o.date = g.date;
  if (g.thumb) o.thumb = g.thumb;
  if (g.desc) o.desc = g.desc;
  if (g.tags && g.tags.length) o.tags = g.tags;
  if (g.people && g.people.length) o.people = g.people;
  if (g.n) o.n = g.n;
  return o;
}

async function main() {
  const t0 = Date.now();
  if (CACHE) fs.mkdirSync(CACHE, { recursive: true });
  const existing = loadExisting();
  console.log(`existing index: ${existing.map.size} galleries (${OUT})`);

  const cards = await walkFeed();
  console.log(`feed: ${cards.length} galleries in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!LIMIT) {
    const extra = await listingCards(new Set(cards.map((c) => c.slug)));
    if (extra.length) console.log(`listing pages: ${extra.length} more not in the feed (${extra.map((c) => c.slug).join(", ")})`);
    cards.push(...extra);
  }
  if (!LIMIT && !args.force && existing.map.size && cards.length < existing.map.size * 0.5) {
    fail(`the feed returned ${cards.length} galleries but the index holds ${existing.map.size}; ` +
         "the site may have changed its feed. Nothing written (use --force to write anyway).");
  }

  // Every entry starts from what the index already knows; a successful page read replaces tags/people/n.
  const entries = cards.map((c) => {
    const prev = existing.map.get(c.slug) || {};
    return { slug: c.slug, title: c.title, date: c.date || prev.date, thumb: c.thumb || prev.thumb,
             desc: c.desc || P.galleryDesc(prev.desc || ""), tags: prev.tags, people: prev.people, n: prev.n };
  });
  // Galleries that dropped out of the feed (or, with --limit, were not walked) stay as they are.
  const inFeed = new Set(entries.map((e) => e.slug));
  let kept = 0;
  for (const g of existing.galleries) {
    if (inFeed.has(g.slug)) continue;
    entries.push(Object.assign({}, g, { desc: P.galleryDesc(g.desc || "") }));
    kept++;
  }

  // With --limit only the walked galleries (the first cards.length entries) are read.
  const todo = entries.filter((e, i) => (!LIMIT || i < cards.length) && (!e.n || REREAD));
  console.log(`gallery pages to read: ${todo.length}` + (CACHE ? ` (cache: ${CACHE})` : ""));
  let done = 0, failed = 0;
  await pool(todo, CONCURRENCY, async (e) => {
    try {
      const page = await readGallery(e.slug);
      e.tags = page.tags;
      e.people = P.extractPeople(page.captions);
      e.n = page.n;
      if (!e.desc && page.desc) e.desc = page.desc;
    } catch (err) {
      failed++;
      console.warn(`  ${e.slug}: ${err.message} (${e.n ? "kept its previous tags/people" : "written without tags/people"}; retried next run)`);
    }
    if (++done % 250 === 0 || done === todo.length) {
      console.log(`  ${done}/${todo.length} pages (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  });

  // Same-day galleries: the feed does not list them in the same order on every request, so the ones the index
  // already holds keep their order in it and new ones come first, in feed order. Otherwise a run that found
  // nothing new could still reorder, and rewrite, the file.
  const feedPos = new Map(entries.map((e, i) => [e.slug, i]));
  const prevPos = new Map(existing.galleries.map((g, i) => [g.slug, i]));
  const rank = (e) => (prevPos.has(e.slug) ? entries.length + prevPos.get(e.slug) : feedPos.get(e.slug));
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || "") || rank(a) - rank(b));
  const galleries = entries.map(compact);

  const withPeople = galleries.filter((g) => g.people).length;
  const photos = galleries.reduce((s, g) => s + (g.n || 0), 0);
  const summary = `${galleries.length} galleries, ${photos.toLocaleString()} photos, ${withPeople} with named people, ` +
                  `${kept} kept from the previous index, ${failed} page(s) failed`;
  if (JSON.stringify(galleries) === JSON.stringify(existing.galleries)) {
    console.log(`unchanged: ${summary}; ${OUT} not rewritten (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } else {
    const index = {
      version: 1,
      generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      base: P.DEFAULT_BASE,
      count: galleries.length,
      galleries
    };
    fs.writeFileSync(OUT, JSON.stringify(index));
    console.log(`wrote ${OUT}: ${summary}, ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (failed) process.exitCode = 2;
}

main().catch((e) => fail(e && e.stack || String(e)));
