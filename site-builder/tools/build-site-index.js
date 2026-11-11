#!/usr/bin/env node
/*
  build-site-index.js — builds the site search's two data files. Node 18+, no dependencies.

    node tools/build-site-index.js [--out-dir DIR] [--bootstrap] [--full] [--force] [--people-minutes N] [--people-only]

  site.json       every news article and podcast episode: slug, title, date, thumbnail, summary (~15,000 + ~2,800,
                  back to 2009), from the site's "Load More" feed (/api/lazy/load, Type "stories" / "audios"), and
                  the players and coaches its text links to their roster pages (people; see below).
  site-goto.json  the "Go to" rows: the curated pages in src/site-pages.json plus every allowed link in the site's
                  header and footer menus (each with its card: share image and description), the roster, the
                  coaching staff and the Hall of Honor, and the curated synonyms. ~50 KB (~8 KB compressed); the widget loads it first.

  Each section has its own rule:
  - stories, audio: merged into what the file holds. Every run walks the feed from the newest card and stops at
    the first page (100 cards) that brings nothing new or changed, usually after one request per feed. A full
    walk of a section (every page, ~190 requests for news) also runs when --full is given or its last complete
    one (fullAt.<section> in site.json) is 20+ hours old, and refreshes edited or backdated items further down.
    Items that leave the feed are kept.
  - players, coaches, legends, menu pages: replaced on every healthy read (a released player must not stay a
    "Go to" row), with health checks: >= 40 players and an "Active" table, >= 5 coaches, >= 3 Hall of Honor
    members, >= 20 allowed menu links including /schedule, /tickets and /team/players-roster. A section that
    fails its check keeps its previous contents.
  - curated pages and synonyms: always the repo's src/site-pages.json (on a full walk each curated URL is checked
    and any that no longer answers 200 is reported).
  - page cards (thumb, desc on each page): on a full walk, or when the file has none yet (no pageReads), every
    page is read for its share image (og:image, on the club's image host only) and descriptions, and the last
    good read of each is kept in pageReads (a page that fails, or is not reached within 90 seconds, keeps its last
    read; pages never read, then the longest unread, go first). Every run makes the cards from those reads and
    src/site-pages.json alone: a curated thumb or desc wins, else the page's image and the first description that
    passes src/site-index.js pageDesc (8+ words, not the site's default, no past season), so taking a curated
    value out, or a new season, shows on the next run.
  - people (players linked in an item's text): each run reads the pages of items not read yet, newest first, three
    at a time, for --people-minutes (2 by default, within the run's 8 minutes): src/site-index.js
    parseArticlePeople. An item keeps its people when its card changes. A page that is gone gets [] (nothing to
    read again); one that fails otherwise stays unread and is tried next run. --people-only does only this (no feed,
    no Go-to pages), for a long catch-up run of the back catalogue.
  A section that fails keeps what the file held, the rest is written, and the exit code is 2. Every run reads the
  newest feed pages first, so new items keep arriving even while full walks fail; a full walk that fails, runs
  over its 6-minute budget, or returns under half of what a section holds (--force writes it anyway) is not used,
  and is retried after 6 hours. A section with no complete full walk for 48 hours makes the exit code 3 (the
  files are still complete; the Action publishes them and then fails the run, so someone looks). When nothing
  changed a file is left untouched (same bytes, same "generated"), so a scheduled job commits nothing.

  --out-dir DIR   where site.json and site-goto.json are read and written (default: this repo)
  --bootstrap     allow site.json not to exist yet (the first build, which is a full walk)
  --full          walk the whole of both feeds
  --force         write a section even when its full walk shrank by more than half
  --people-minutes N   read article pages for their linked players for N minutes (default 2)
  --people-only   only read article pages for their players (site.json must exist; site-goto.json is untouched)

  The parsing and URL rules live in src/site-index.js, which the widget also runs (on the live feed at page load,
  and to gate every link it shows), so the builder and the page can never disagree about a card or a URL.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("../src/site-index.js");
const PVI = require("../src/index-normalize.js");
const CURATED = path.join(__dirname, "..", "src", "site-pages.json");

const ORIGIN = S.ORIGIN;
const UA = "Mozilla/5.0 (compatible; panthers-site-index/1.0)";
const RETRIES = 3;
const FULL_EVERY_MS = 20 * 3600 * 1000;   // a section's full walk is due this long after its last complete one
const FULL_RETRY_MS = 6 * 3600 * 1000;    // ... and, after a failed attempt, not again for this long
const FULL_STALE_MS = 48 * 3600 * 1000;   // no complete full walk for this long: exit 3, the run goes red
const FULL_BUDGET_MS = 6 * 60 * 1000;     // full walks stop after this (the Action stops the builder at 9 minutes)
const PAGES_BUDGET_MS = 90 * 1000;        // reading the pages' cards stops after this (the rest keep their last read)
const RUN_LIMIT_MS = 8 * 60 * 1000;       // ... and by this long after the start (the Action stops the builder at 9 minutes)
const COMMON_DESC = 3;                    // a description this many pages give is the site's default, not theirs
const PEOPLE_WORKERS = 3;                 // article pages read at once for their players
const OVERLAP = 5;               // a full walk steps 95 cards at a time, so an item inserted mid-walk is not skipped
const INCREMENTAL_MAX_PAGES = 10;
// Pause between requests to panthers.com (ms). tests/site-builder.test.js sets SITE_INDEX_DELAY_MS=0 (its fetch is stubbed).
const DELAY = process.env.SITE_INDEX_DELAY_MS != null ? Math.max(0, +process.env.SITE_INDEX_DELAY_MS || 0) : 200;
const USAGE = "usage: node tools/build-site-index.js [--out-dir DIR] [--bootstrap] [--full] [--force] [--people-minutes N] [--people-only]   " +
              "(see the comment at the top of this file)";

const args = parseArgs(process.argv.slice(2));
const DIR = path.resolve(args["out-dir"] || path.join(__dirname, ".."));
const SITE = path.join(DIR, "site.json");
const GOTO = path.join(DIR, "site-goto.json");
// How long article pages are read for their players. tests/site-builder.test.js sets SITE_INDEX_PEOPLE_MS (0: none).
const PEOPLE_BUDGET_MS = process.env.SITE_INDEX_PEOPLE_MS != null ? Math.max(0, +process.env.SITE_INDEX_PEOPLE_MS || 0)
  : args["people-minutes"] != null ? Math.max(0, +args["people-minutes"] || 0) * 60000 : 2 * 60000;

function parseArgs(argv) {
  const out = {}, flags = ["bootstrap", "full", "force", "people-only"], values = ["out-dir", "people-minutes"];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") { console.log(USAGE); process.exit(0); }
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m && flags.includes(m[1]) && m[2] === undefined) { out[m[1]] = true; continue; }
    if (!m || !values.includes(m[1])) fail(`unknown argument ${argv[i]}\n${USAGE}`);
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (v === undefined || v === "" || v.startsWith("--")) fail(`--${m[1]} needs a value\n${USAGE}`);
    out[m[1]] = v;
  }
  return out;
}

function fail(msg) {
  console.error("build-site-index: " + msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function get(url, opts) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    requests++;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
      last = new Error("HTTP " + r.status);
      if (r.status === 404 || (opts && opts.once)) break;
    } catch (e) { last = e; }
    await sleep(1000 * attempt * attempt);
  }
  throw last;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`${file} is not valid JSON: ${e.message}`); }
}

// ── Feeds ───────────────────────────────────────────────────────────────────────────────────────
// Comparable form of a card (what the file stores), so "changed" means a change the index would keep.
function compact(c) {
  const o = { slug: c.slug, title: c.title };
  if (c.date) o.date = c.date;
  if (c.thumb) o.thumb = c.thumb;
  if (c.desc) o.desc = c.desc;
  return o;
}
const same = (a, b) => JSON.stringify(compact(a)) === JSON.stringify(compact(b));
// What the file stores for an item: its card, and once its page has been read the names its text links (people,
// possibly []). Kept apart from compact so a card from the feed (which has no people) still compares as unchanged.
// reread: its card changed since its page was read (a writer who edits a post may have linked another player); the
// next run reads it again, keeping the people it has meanwhile.
function stored(c, people, reread) {
  const o = compact(c);
  if (Array.isArray(people)) o.people = people.filter((n) => typeof n === "string" && n).slice(0, 20);
  if (reread && o.people) o.reread = 1;
  return o;
}

// The feed's last page says so (data-hasnextpage="false"); past the end it answers 200 with an empty body, which
// is why an empty page is never taken for the end.
const isLastPage = (html) => typeof html === "string" && html.indexOf('data-hasnextpage="false"') !== -1;

// Whole feed, newest first. An empty page before the feed says it ended is a failure, not the end.
async function walkFull(section, deadline) {
  const cards = [], seen = new Set();
  let skip = 0;
  for (let page = 0; page < 1000; page++) {
    if (Date.now() > deadline) throw new Error(`${section}: full walk stopped at skip=${skip}, over its ${FULL_BUDGET_MS / 60000}-minute budget`);
    const html = await get(ORIGIN + S.feedUrl(section, skip, S.FEED_MAX));
    const got = S.parseCards(html, section);
    const last = isLastPage(html);
    if (!got.length && !last) throw new Error(`${section}: empty page at skip=${skip} before the end of the feed`);
    for (const c of got) if (!seen.has(c.slug)) { seen.add(c.slug); cards.push(c); }
    if (last) return { cards, complete: true };
    if (got.length < S.FEED_MAX) console.warn(`  ${section}: page at skip=${skip} held ${got.length} of ${S.FEED_MAX}`);
    skip += Math.max(1, got.length - OVERLAP);
    await sleep(DELAY);
  }
  throw new Error(`${section}: feed did not end after 1000 pages`);
}

// From the newest card until a page brings nothing new or changed. The first page must look like the feed:
// >= 90 cards (unless it is the whole feed) and, once the file holds anything, at least one known item.
async function walkIncremental(section, known) {
  const cards = [], seen = new Set();
  let skip = 0;
  for (let page = 0; page < INCREMENTAL_MAX_PAGES; page++) {
    const html = await get(ORIGIN + S.feedUrl(section, skip, S.FEED_MAX));
    const got = S.parseCards(html, section);
    const last = isLastPage(html);
    if (page === 0) {
      if (got.length < 90 && !last) throw new Error(`${section}: the first feed page held only ${got.length} cards`);
      if (known.size && !got.some((c) => known.has(c.slug))) throw new Error(`${section}: the first feed page holds no item the index knows`);
    }
    let news = 0;
    for (const c of got) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug); cards.push(c);
      const prev = known.get(c.slug);
      if (!prev || !same(prev, c)) news++;
    }
    if (!news || last) return cards;
    skip += Math.max(1, got.length - OVERLAP);
    await sleep(DELAY);
  }
  return cards;
}

// Walked cards over the file's list: new first (feed order), known ones take the feed's text, the rest stay.
// Same-day items keep the file's order, so a feed that lists a day differently does not rewrite the file.
function mergeSection(prev, cards) {
  const prevPos = new Map(prev.map((x, i) => [x.slug, i]));
  const byPrev = new Map(prev.map((x) => [x.slug, x]));
  const walked = new Set();
  const entries = cards.map((c) => {
    walked.add(c.slug);
    const p = byPrev.get(c.slug) || {};
    const card = { slug: c.slug, title: c.title, date: c.date || p.date, thumb: c.thumb || p.thumb, desc: c.desc || p.desc };
    // Changed: what is kept differs from the file's (not just from the bare card, which may lack a summary).
    return stored(card, p.people, p.reread || (!!p.slug && !same(p, card)));
  });
  for (const x of prev) if (!walked.has(x.slug)) entries.push(stored(x, x.people, x.reread));
  const feedPos = new Map(entries.map((e, i) => [e.slug, i]));
  const rank = (e) => (prevPos.has(e.slug) ? entries.length + prevPos.get(e.slug) : feedPos.get(e.slug));
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || "") || rank(a) - rank(b));
  return entries;
}

// ── Go-to sections ──────────────────────────────────────────────────────────────────────────────
function checkMenus(pages) {
  const urls = new Set(pages.map((p) => S.urlKey(p.url)));
  const need = ["/schedule", "/tickets", "/team/players-roster"].map((p) => ORIGIN + p);
  if (pages.length < 20) return `only ${pages.length} allowed menu links`;
  const missing = need.filter((u) => !urls.has(u));
  return missing.length ? "menu links missing " + missing.join(", ") : "";
}

async function readSection(name, url, parse, check) {
  try {
    const value = parse(await get(ORIGIN + url));
    const bad = check(value);
    if (bad) throw new Error(bad);
    return { ok: true, value };
  } catch (e) {
    console.warn(`  ${name}: ${e.message} (kept the previous ${name})`);
    return { ok: false };
  }
}

function applyPeopleAliases(list, type, curated) {
  const extra = new Map();
  for (const p of curated.people || []) if (p && p.type === type && p.slug) extra.set(p.slug, p.aliases || []);
  return list.map((x) => (extra.has(x.slug) ? Object.assign({}, x, { aliases: extra.get(x.slug) }) : x));
}

// Curated pages first (their order and wording), then menu links no curated entry covers, in menu order.
function mergePages(curated, menus) {
  const out = [], seen = new Set();
  for (const p of curated.pages || []) {
    const url = S.allowedUrl(String(p && p.url || ""));
    if (!url) { console.warn(`  curated page dropped (not an allowed URL): ${p && p.url}`); continue; }
    if (seen.has(S.urlKey(url))) continue;
    seen.add(S.urlKey(url));
    const related = (Array.isArray(p.related) ? p.related : []).map((u) => S.allowedUrl(String(u || ""))).filter(Boolean);
    if (related.length !== (Array.isArray(p.related) ? p.related.length : 0)) console.warn(`  curated related link dropped (not an allowed URL) on ${url}`);
    out.push(Object.assign({ url, title: p.title, aliases: p.aliases || [] }, related.length ? { related } : {}));
  }
  for (const m of menus) {
    if (seen.has(S.urlKey(m.url))) continue;
    seen.add(S.urlKey(m.url));
    out.push({ url: m.url, title: m.title, aliases: [] });
  }
  return out;
}

// The "Popular Pages" before a query: curated page URLs only (a typo here would otherwise show nothing).
function quickPages(curated) {
  const pages = new Set((curated.pages || []).map((p) => S.urlKey(S.allowedUrl(String(p && p.url || "")))));
  return (curated.quick || []).filter((u) => {
    const ok = pages.has(S.urlKey(S.allowedUrl(String(u))));
    if (!ok) console.warn(`  quick link dropped (not a curated page): ${u}`);
    return ok;
  });
}

const curatedKey = (p) => S.urlKey(S.allowedUrl(String(p && p.url || "")));

// Reads pages for their cards (S.parsePageMeta) and reports curated URLs that no longer answer 200. Pages never read
// go first, then the longest since their last read, so a budget that runs out does not leave the same pages unread
// run after run. Returns urlKey -> { at, thumb, descs } for the pages read now; one that fails, or is not reached in
// time, is left out (its last read stays).
async function readPages(pages, curated, prevReads, stopBy) {
  const read = new Map(), bad = [], deadline = Math.min(Date.now() + PAGES_BUDGET_MS, stopBy);
  const keys = new Set((curated.pages || []).map(curatedKey));
  const last = (p) => { const r = prevReads[S.urlKey(p.url)]; return r ? Date.parse(r.at) || 0 : -1; };
  const order = pages.map((p, i) => [p, i]).sort((a, b) => last(a[0]) - last(b[0]) || a[1] - b[1]).map((x) => x[0]);
  for (const p of order) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.warn(`  page cards: out of time with ${read.size} of ${pages.length} pages read (the rest keep their last read)`);
      break;
    }
    const isCurated = keys.has(S.urlKey(p.url));
    try {
      const r = await fetch(p.url, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(Math.min(15000, left)) });
      requests++;
      if (r.status === 200) read.set(S.urlKey(p.url), Object.assign({ at: stamp() }, S.parsePageMeta(await r.text())));
      else if (isCurated) bad.push(`${p.url} -> ${r.status}${r.headers && r.headers.get ? " " + (r.headers.get("location") || "") : ""}`);
    } catch (e) { if (isCurated) bad.push(`${p.url} -> ${e.message}`); }
    await sleep(DELAY / 2);
  }
  if (bad.length) console.warn(`  curated pages that no longer answer 200 (fix src/site-pages.json):\n    ${bad.join("\n    ")}`);
  return read;
}

// "upload/<id>", or a full URL on the club's image host -> "upload/<id>"; anything else "".
function compactThumb(t) {
  t = typeof t === "string" ? t.trim() : "";
  const c = /^(?:upload|private)\/[A-Za-z0-9_-]+$/.test(t) ? t : PVI.sitemapThumb(t);
  return /^(?:upload|private)\/[A-Za-z0-9_-]+$/.test(c) ? c : "";
}

// The last good read of each page still listed: this run's, else the file's (whatever shape the file holds).
function mergeReads(pages, prevReads, read) {
  const out = {};
  for (const p of pages) {
    const k = S.urlKey(p.url), r = read.get(k) || prevReads[k];
    if (!r || typeof r !== "object") continue;
    const thumb = compactThumb(r.thumb), descs = (Array.isArray(r.descs) ? r.descs : []).filter((d) => typeof d === "string" && d);
    out[k] = Object.assign({ at: typeof r.at === "string" ? r.at : "" }, thumb ? { thumb } : {}, descs.length ? { descs } : {});
  }
  return out;
}

// Each page's card, from its last read and src/site-pages.json alone (never from the previous cards, so a curated
// value taken out, or a new season, shows on the next run): a curated thumb or desc wins; else the page's share
// image and the first description of its own (S.pageDesc; one that three or more pages give is the site's default).
function pageCards(pages, curated, reads, season) {
  const counts = new Map();
  for (const r of Object.values(reads)) for (const d of new Set(r.descs || [])) counts.set(d, (counts.get(d) || 0) + 1);
  const common = new Set([...counts].filter(([, n]) => n >= COMMON_DESC).map(([d]) => d));
  const cur = new Map((curated.pages || []).map((p) => [curatedKey(p), p]));
  return pages.map((p) => {
    const k = S.urlKey(p.url), c = cur.get(k) || {}, r = reads[k] || {};
    const ownThumb = compactThumb(c.thumb);
    if (c.thumb && !ownThumb) console.warn(`  curated thumb dropped (not an image on static.clubs.nfl.com): ${c.thumb}`);
    const ownDesc = typeof c.desc === "string" ? PVI.cleanText(c.desc) : "";
    const thumb = ownThumb || r.thumb || "";
    const desc = ownDesc || S.pageDesc(r.descs, common, season);
    return Object.assign({}, p, thumb ? { thumb } : {}, desc ? { desc } : {});
  });
}

// ── An item's linked players ────────────────────────────────────────────────────────────────────
// Reads the pages of items not read yet (no people) or to read again (reread), newest first, PEOPLE_WORKERS at a
// time, until `deadline`. Each gets the names its text links (S.parseArticlePeople; [] for none, or for a page that
// is gone). A page that fails otherwise is left as it was and read next run. The site saying "slow down" (429, 403)
// or PEOPLE_FAILS failures in a row ends the reading for this run.
const PEOPLE_FAILS = 5;
async function readPeople(sections, deadline) {
  const todo = [];
  for (const name of ["stories", "audio"]) {
    for (const x of sections[name]) if (!Array.isArray(x.people) || x.reread) todo.push({ x, path: S.SECTIONS[name].path });
  }
  todo.sort((a, b) => (b.x.date || "").localeCompare(a.x.date || ""));
  let next = 0, read = 0, named = 0, fails = 0, stop = "";
  const statuses = {};
  const work = async () => {
    while (next < todo.length && Date.now() < deadline && !stop) {
      const t = todo[next++];
      let status = "error";
      try {
        const left = deadline - Date.now();
        const r = await fetch(ORIGIN + t.path + t.x.slug, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(Math.max(1000, Math.min(20000, left))) });
        requests++;
        status = r.status;
        if (r.status === 200) { t.x.people = S.parseArticlePeople(await r.text()); delete t.x.reread; read++; if (t.x.people.length) named++; }
        else {
          if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
          if (r.status === 404 || r.status === 410) { t.x.people = []; delete t.x.reread; read++; }
        }
      } catch (e) { /* timed out or failed: read next run */ }
      statuses[status] = (statuses[status] || 0) + 1;
      if (status === 429 || status === 403) stop = "the site answered " + status;
      else if (status === 200 || status === 404 || status === 410) fails = 0;
      else if (++fails >= PEOPLE_FAILS) stop = PEOPLE_FAILS + " failures in a row";
      await sleep(DELAY / 2);
    }
  };
  if (todo.length && deadline > Date.now()) await Promise.all(Array.from({ length: PEOPLE_WORKERS }, work));
  const left = todo.filter((t) => !Array.isArray(t.x.people) || t.x.reread).length;
  if (todo.length) {
    console.log(`  players: ${read} pages read (${named} link players), ${left} still to read` + (stop ? `; stopped: ${stop}` : "") +
                ` (answers: ${JSON.stringify(statuses)})`);
  }
  if (stop) console.warn(`  players: stopped reading article pages, ${stop}; the rest are read next run`);
}

// ── Write ───────────────────────────────────────────────────────────────────────────────────────
function stamp() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

// Writes {version, generated, ...body} unless body equals what the file holds (then the file is untouched).
function writeIfChanged(file, prev, body, label) {
  const strip = (o) => { const c = Object.assign({}, o); delete c.generated; return JSON.stringify(c); };
  const next = Object.assign({ version: 1, generated: "" }, body);
  if (prev && strip(prev) === strip(next)) { console.log(`unchanged: ${label}; ${file} not rewritten`); return false; }
  next.generated = stamp();
  fs.writeFileSync(file, JSON.stringify(next));
  console.log(`wrote ${file}: ${label}, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
  return true;
}

async function main() {
  const t0 = Date.now();
  const curated = readJson(CURATED);
  let site = null;
  if (fs.existsSync(SITE)) {
    site = readJson(SITE);
    if (!site || site.version !== 1 || !Array.isArray(site.stories) || !Array.isArray(site.audio)) fail(`${SITE} is not a site index`);
  } else if (!args.bootstrap) {
    fail(`${SITE} does not exist. Pass --bootstrap for a first build (a full walk of both feeds), or --out-dir an existing index.`);
  }
  const gotoPrev = fs.existsSync(GOTO) ? readJson(GOTO) : null;
  // Per section: when its last complete full walk ran, and when a full walk last failed. (A plain string is the
  // format before the two sections were tracked apart.)
  const perSection = (v) => (typeof v === "string" ? { stories: v, audio: v } : Object.assign({}, v || {}));
  const fullAt = perSection(site && site.fullAt), triedAt = perSection(site && site.fullTriedAt);
  const now = Date.now(), deadline = now + FULL_BUDGET_MS, ms = (v) => Date.parse(v || "") || 0;
  console.log(`site index: ${site ? `${site.stories.length} stories, ${site.audio.length} podcasts, last full walks ${JSON.stringify(fullAt)}` : "none (bootstrap)"}`);

  if (args["people-only"]) {
    if (!site) fail("--people-only needs an existing site.json");
    const only = { stories: site.stories.filter((x) => x && x.slug).map((x) => stored(x, x.people)),
                   audio: site.audio.filter((x) => x && x.slug).map((x) => stored(x, x.people)) };
    await readPeople(only, Date.now() + PEOPLE_BUDGET_MS);
    const body = Object.assign({}, site, { stories: only.stories, audio: only.audio });
    delete body.version; delete body.generated;
    writeIfChanged(SITE, site, body, `${body.stories.length} stories, ${body.audio.length} podcasts`);
    console.log(`done: ${requests} requests, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return;
  }

  // Every run walks the newest pages first, so new items arrive whatever a full walk does; a due full walk then
  // refreshes the whole section, and its cards are merged only when it completes and passes the shrink guard.
  let failed = 0, stale = 0, fullRan = false;
  const sections = {};
  for (const name of ["stories", "audio"]) {
    const prev = site ? site[name].filter((x) => x && x.slug) : [];
    let merged = prev.map((x) => stored(x, x.people, x.reread));
    if (prev.length) {
      try {
        const cards = await walkIncremental(name, new Map(prev.map((x) => [x.slug, x])));
        merged = mergeSection(prev, cards);
        console.log(`  ${name}: newest pages, ${cards.length} cards walked, ${merged.length - prev.length} new`);
      } catch (e) {
        failed++;
        console.warn(`  ${name}: ${e.message} (kept the previous ${prev.length})`);
      }
    }
    const due = !!args.full || !prev.length ||
                (now - ms(fullAt[name]) >= FULL_EVERY_MS && now - ms(triedAt[name]) >= FULL_RETRY_MS);
    if (due) {
      fullRan = true;
      try {
        const w = await walkFull(name, deadline);
        if (prev.length && w.cards.length < prev.length * 0.5 && !args.force) {
          throw new Error(`the feed returned ${w.cards.length} items but the index holds ${prev.length}; the site may have ` +
                          "changed its feed (use --force to write anyway)");
        }
        const before = JSON.stringify(merged);
        merged = mergeSection(merged, w.cards);
        fullAt[name] = stamp();
        delete triedAt[name];
        console.log(`  ${name}: full walk, ${w.cards.length} cards, ${merged.length} in all` + (JSON.stringify(merged) === before ? " (no change)" : ""));
      } catch (e) {
        failed++;
        triedAt[name] = stamp();
        console.warn(`  ${name}: ${e.message} (full walk not used; retried in ${FULL_RETRY_MS / 3600000} h)`);
      }
    }
    if (!fullAt[name] || now - ms(fullAt[name]) > FULL_STALE_MS) {
      stale++;
      console.warn(`  ${name}: no complete full walk since ${fullAt[name] || "ever"}; older items may be out of date`);
    }
    sections[name] = merged;
  }

  const menus = await readSection("menu pages", "/", S.parseMenus, checkMenus);
  const roster = await readSection("players", "/team/players-roster/", S.parseRoster,
    (r) => (r.players.length < 40 ? `only ${r.players.length} players` : !r.active ? "no Active table" : ""));
  const coaches = await readSection("coaches", "/team/coaches-roster/", S.parseCoaches, (c) => (c.length < 5 ? `only ${c.length} coaches` : ""));
  const legends = await readSection("legends", "/team/hall-of-honor/", S.parseHallOfHonor, (l) => (l.length < 3 ? `only ${l.length} Hall of Honor members` : ""));
  for (const r of [menus, roster, coaches, legends]) if (!r.ok) failed++;

  const prevMenus = (gotoPrev && gotoPrev.menus) || [];
  const pages = mergePages(curated, menus.ok ? menus.value : prevMenus);
  const prevReads = gotoPrev && gotoPrev.pageReads && typeof gotoPrev.pageReads === "object" ? gotoPrev.pageReads : null;
  const pagesDue = fullRan || !prevReads;
  const read = pagesDue ? await readPages(pages, curated, prevReads || {}, t0 + RUN_LIMIT_MS) : new Map();
  if (pagesDue) console.log(`  page cards: ${read.size} of ${pages.length} pages read`);
  const reads = mergeReads(pages, prevReads || {}, read);
  // A season runs into February. tests/site-builder.test.js sets SITE_INDEX_TODAY to move the date.
  const today = new Date(process.env.SITE_INDEX_TODAY || now), season = today.getUTCFullYear() - (today.getUTCMonth() < 2 ? 1 : 0);
  const goto = {
    menus: menus.ok ? menus.value : prevMenus,
    pages: pageCards(pages, curated, reads, season),
    players: applyPeopleAliases(roster.ok ? roster.value.players : (gotoPrev && gotoPrev.players) || [], "player", curated),
    coaches: applyPeopleAliases(coaches.ok ? coaches.value : (gotoPrev && gotoPrev.coaches) || [], "coach", curated),
    legends: applyPeopleAliases(legends.ok ? legends.value : (gotoPrev && gotoPrev.legends) || [], "legend", curated),
    quick: quickPages(curated),
    synonyms: curated.synonyms || [],
    pageReads: reads
  };
  writeIfChanged(GOTO, gotoPrev, goto,
    `${goto.pages.length} pages, ${goto.players.length} players, ${goto.coaches.length} coaches, ${goto.legends.length} legends`);

  // The players linked in items not read yet, with what is left of the run.
  await readPeople(sections, Math.min(Date.now() + PEOPLE_BUDGET_MS, t0 + RUN_LIMIT_MS));

  // A full walk that changed nothing still records when it ran (so the next one waits 20 h).
  const body = { fullAt, stories: sections.stories, audio: sections.audio };
  if (Object.keys(triedAt).length) body.fullTriedAt = triedAt;
  writeIfChanged(SITE, site, body, `${body.stories.length} stories, ${body.audio.length} podcasts`);
  console.log(`done: ${requests} requests, ${((Date.now() - t0) / 1000).toFixed(0)}s` + (failed ? `, ${failed} section(s) kept their previous contents` : ""));
  // 3 (stale) wins over 2: both files are complete either way; 3 means a person should look.
  if (stale) process.exitCode = 3;
  else if (failed) process.exitCode = 2;
}

main().catch((e) => fail(e && e.stack || String(e)));
