/*!
 * PanthersPhotoIndex — gallery parsing and index normalisation for the photo search. Shared by the widget
 * (src/widget.js built with KIND "photo"), the index builder (tools/build-photo-index.js) and the Node tests.
 * No DOM, ES2018. Depends on PanthersVideoIndex (src/index-normalize.js) for text cleaning and URL gating;
 * build.js inlines it after that file.
 *
 * Browser: window.PanthersPhotoIndex   Node: module.exports
 *
 * panthers.com publishes no photo sitemap. The galleries come from the site's own "Load More" backend,
 * /api/lazy/load, which pages through every gallery (2008 onwards) newest first:
 *
 *   PanthersPhotoIndex.feedUrl(skip, count)    -> "/api/lazy/load?json=..." (count is capped at FEED_MAX)
 *   PanthersPhotoIndex.parseCards(html)        -> [{ slug, title, date, thumb, desc }]  (a feed page)
 *   PanthersPhotoIndex.hasNextPage(html)       -> false on the feed's last page
 *   PanthersPhotoIndex.parseGalleryPage(html)  -> { tags, n, captions, desc }  (one /photos/<slug> page)
 *   PanthersPhotoIndex.extractPeople(captions) -> ["Robert Rochell", ...] most-mentioned first
 *   PanthersPhotoIndex.normalizeIndex(json)    -> { version, base, galleries }
 *     every gallery becomes the engine's object:
 *       { title, url, date, thumb (full https URL or ""), desc, tags: string[], people: string[], n, slug }
 *   PanthersPhotoIndex.mergeFresh(galleries, cards) -> { galleries, added, updated }
 *
 * Security: the same rules as the video index. Index base URLs must be https://www.panthers.com/ (galleries)
 * and https://static.clubs.nfl.com/ (thumbs) or they fall back to the defaults; thumbs go through
 * PanthersVideoIndex.thumbUrl; everything parsed from HTML is decoded to plain text (the widget escapes it).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./index-normalize.js"));
  } else {
    root.PanthersPhotoIndex = factory(root.PanthersVideoIndex);
  }
}(typeof window !== "undefined" ? window : this, function (PVI) {
  "use strict";

  var DEFAULT_BASE = { url: "https://www.panthers.com/photos/", thumb: "https://static.clubs.nfl.com/image/" };
  var GALLERY_ORIGIN = "https://www.panthers.com";
  var THUMB_ORIGIN = "https://static.clubs.nfl.com";
  var DESC_MAX = 400;
  var PEOPLE_MAX = 40;
  // The feed silently returns 25 items for any Count above 100, which makes a walk skip most of the archive.
  var FEED_MAX = 100;

  // Listing pages under /photos/ that are not galleries (the site's photo navigation).
  var CAT_SLUGS = {};
  ["archives", "gameday", "my-view", "off-the-field", "through-the-years", "travel", "all"
  ].forEach(function (s) { CAT_SLUGS[s] = true; });

  function isCategorySlug(slug) {
    return Object.prototype.hasOwnProperty.call(CAT_SLUGS, String(slug).toLowerCase());
  }
  // The listing pages the builder also reads: a few galleries appear there but not in the feed
  // (e.g. /photos/panthers-vs-bengals-through-the-years, found only on /photos/through-the-years).
  var LISTINGS = ["", "archives", "gameday", "my-view", "off-the-field", "through-the-years", "travel"];

  function slugFromUrl(url) {
    var x;
    try { x = new URL(String(url == null ? "" : url).trim(), DEFAULT_BASE.url); } catch (e) { return ""; }
    var p = x.pathname, i = p.indexOf("/photos/");
    if (i === -1) return "";
    return p.slice(i + 8).replace(/^\/+|\/+$/g, "");
  }

  // ── Feed ────────────────────────────────────────────────────────────────────────────────────────
  // The module config the site's lazyloadmore.js sends for an untagged "albums" list.
  function feedUrl(skip, count) {
    count = Math.max(1, Math.min(FEED_MAX, count | 0 || FEED_MAX));
    var cfg = {
      Name: "EditorialList",
      Module: {
        View: "Card async", ShowDate: true, HideDescription: false, MoreLink: "#load-more",
        ExtraClass: "d3-is-lazy-load-more", Selection: null, Type: "albums", Tags: null,
        Skip: Math.max(0, skip | 0), Count: count
      }
    };
    return "/api/lazy/load?json=" + encodeURIComponent(JSON.stringify(cfg));
  }

  function hasNextPage(html) {
    return typeof html === "string" && html.indexOf('data-hasnextpage="false"') === -1 &&
           html.indexOf('data-hasnextpage="true"') !== -1;
  }

  // ── Text ────────────────────────────────────────────────────────────────────────────────────────
  var RE_TAG = /<[^>]*>/g;
  var RE_TITLE_PREFIX = /^photos?\s*[:|\u2013\u2014-]\s*/i;

  function htmlText(s) {
    return PVI.cleanText(PVI.decodeHtml(String(s == null ? "" : s).replace(RE_TAG, " ")));
  }

  // "PHOTOS: Panthers at Steelers" -> "Panthers at Steelers": on a photo search every title would match "photos".
  function cleanGalleryTitle(s) {
    var t = PVI.cleanTitle(s);
    var u = t.replace(RE_TITLE_PREFIX, "");
    return u || t;
  }

  function truncate(s, max) {
    if (s.length <= max) return s;
    var cut = s.slice(0, max - 1), sp = cut.lastIndexOf(" ");
    if (sp > max / 2) cut = cut.slice(0, sp);
    return cut.replace(/[ ,;:.\-\u2013\u2014]+$/, "") + "\u2026";
  }

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var RE_CARD_DATE = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/;

  // "Nov 03, 2026" -> "2026-11-03"; anything else -> "".
  function cardDate(s) {
    var m = RE_CARD_DATE.exec(PVI.cleanText(s));
    if (!m) return "";
    var mo = MONTHS[m[1].toLowerCase()], d = +m[2];
    if (!mo || d < 1 || d > 31) return "";
    return m[3] + "-" + (mo < 10 ? "0" : "") + mo + "-" + (d < 10 ? "0" : "") + d;
  }

  // ── Feed cards ──────────────────────────────────────────────────────────────────────────────────
  var RE_CARD = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  var RE_HREF = /\bhref="([^"]*)"/;
  var RE_TITLE_ATTR = /\btitle="([^"]*)"/;
  var RE_CARD_TITLE = /class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/;
  var RE_CARD_DATE_EL = /class="[^"]*__date[^"]*"[^>]*>([\s\S]*?)<\/p>/;
  var RE_CARD_SUMMARY = /class="[^"]*__summary[^"]*"[^>]*>([\s\S]*?)<\/div>/;
  var RE_CLOUDINARY = new RegExp("https://static\\.clubs\\.nfl\\.com/image/(?:upload|private)/[^\"'\\s,]*?/panthers/[A-Za-z0-9_-]+", "i");

  // Cards in a feed page (or a /photos/ listing page). A card whose link is not a gallery, or that has no
  // title, is skipped; garbage input returns [].
  function parseCards(html) {
    var out = [], seen = {};
    if (typeof html !== "string" || html.indexOf("<a") === -1) return out;
    RE_CARD.lastIndex = 0;
    var m;
    while ((m = RE_CARD.exec(html))) {
      var attrs = m[1], body = m[2];
      var href = RE_HREF.exec(attrs);
      if (!href) continue;
      var url = PVI.decodeHtml(href[1]);
      var abs = PVI.httpUrl(url, GALLERY_ORIGIN + "/");
      if (!abs || abs.indexOf(GALLERY_ORIGIN + "/photos/") !== 0) continue;
      var slug = slugFromUrl(abs).split(/[?#]/)[0];
      if (!slug || slug.indexOf("/") !== -1 || isCategorySlug(slug) || seen[slug]) continue;
      var tm = RE_CARD_TITLE.exec(body), ta = RE_TITLE_ATTR.exec(attrs);
      var title = cleanGalleryTitle(tm ? htmlText(tm[1]) : (ta ? PVI.decodeHtml(ta[1]) : ""));
      if (!title) continue;
      seen[slug] = true;
      var e = { slug: slug, title: title };
      var dm = RE_CARD_DATE_EL.exec(body);
      var date = dm ? cardDate(htmlText(dm[1])) : "";
      if (date) e.date = date;
      var im = RE_CLOUDINARY.exec(body);
      var thumb = im ? PVI.sitemapThumb(im[0]) : "";
      if (thumb) e.thumb = thumb;
      var sm = RE_CARD_SUMMARY.exec(body);
      var desc = sm ? truncate(htmlText(sm[1]), DESC_MAX) : "";
      if (desc) e.desc = desc;
      out.push(e);
    }
    return out;
  }

  // ── Gallery page ────────────────────────────────────────────────────────────────────────────────
  // Tags carry no search value when every gallery of an era has them.
  var NOISE_TAGS = { "latest photos": 1, "team": 1, "migrated": 1, "photos": 1, "photo gallery": 1, "gallery": 1,
                     "test": 1, "spotlight": 1, "carolina panthers": 1, "panthers": 1, "fr-hide": 1, "fr-live": 1,
                     "draft-tracker-card": 1, "nfl-draft-card": 1 };
  var RE_KEYWORDS = /"keywords"\s*:\s*(\[[^\]]*\])/;
  var RE_META_DESC = /<meta\s+name="description"\s+content="([^"]*)"/i;
  // A page with no description of its own carries the site's default one (386 galleries), and a missing gallery
  // redirects to /photos/ with its listing text. Neither describes the gallery: as a desc they made every such
  // gallery match "tickets", "news" or "statistics".
  var RE_SITE_DESC = /^(?:the official website of the carolina panthers|carolina panthers: official photos)/i;
  var RE_PROGRESS = /<span>\s*\d+\s*\/\s*(\d+)\s*<\/span>/;
  var RE_CAPTION = /nfl-c-photo-album__photo-caption"[^>]*>([\s\S]*?)<\/div>/;
  var RE_IMG_ALT = /<img\b[^>]*\balt="([^"]*)"/;
  var PICTURE_MARK = 'class="nfl-c-photo-album__picture-wrapper"';

  function pageTags(html) {
    var m = RE_KEYWORDS.exec(html), list = [];
    if (!m) return list;
    try { list = JSON.parse(m[1]); } catch (e) { return []; }
    return cleanTags(list);
  }

  function cleanTags(list) {
    var out = [], seen = {};
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i] !== "string") continue;
      var t = PVI.cleanText(list[i]), low = t.toLowerCase();
      if (!t || NOISE_TAGS[low] || seen[low] || t.indexOf("=") !== -1) continue;   // "adpartner=..." is ad targeting
      seen[low] = true;
      out.push(t);
    }
    return out;
  }

  // The page's own description, or "" for the site default.
  function galleryDesc(s) {
    var t = PVI.cleanText(PVI.decodeHtml(s));
    return RE_SITE_DESC.test(t) ? "" : truncate(t, DESC_MAX);
  }

  // A real caption is prose ("Cornerback Robert Rochell is seen during practice ..."). Most galleries since
  // ~2016 carry camera file names instead ("AH102849", "231001 WK 4_Vikings_Intros-47", "IMG_4614",
  // "No Title"), which must never become search text.
  var RE_LOWER_WORD = /^[a-z][a-z'\u2019]+$/;
  function isCaption(s) {
    if (!s || s.length < 12 || s.indexOf("_") !== -1) return false;
    var ws = s.split(" "), lower = 0;
    for (var i = 0; i < ws.length; i++) if (RE_LOWER_WORD.test(ws[i])) lower++;
    return lower >= 2;
  }

  // { tags, n, captions, desc } for one gallery page. n = photos in the gallery; captions = its distinct real
  // captions in page order.
  function parseGalleryPage(html) {
    var res = { tags: [], n: 0, captions: [], desc: "" };
    if (typeof html !== "string") return res;
    res.tags = pageTags(html);
    var md = RE_META_DESC.exec(html);
    if (md) res.desc = galleryDesc(md[1]);
    var parts = html.split(PICTURE_MARK), seen = {};
    for (var i = 1; i < parts.length; i++) {
      var p = parts[i];
      var cm = RE_CAPTION.exec(p), am = RE_IMG_ALT.exec(p);
      var cap = cm ? htmlText(cm[1]) : "";
      if (!isCaption(cap)) cap = am ? PVI.cleanText(PVI.decodeHtml(am[1])) : "";
      if (!isCaption(cap) || seen[cap]) continue;
      seen[cap] = true;
      res.captions.push(cap);
    }
    var pm = RE_PROGRESS.exec(html);
    res.n = Math.max(parts.length - 1, pm ? +pm[1] : 0);
    return res;
  }

  // ── People ──────────────────────────────────────────────────────────────────────────────────────
  // Names are runs of capitalised words in the captions, with the leading team, position and role words
  // removed ("Carolina Panthers running back DeAngelo Williams (34)" -> "DeAngelo Williams"). A run that is a
  // place, venue, event or anything else in REJECT is dropped. Opponents' players are kept on purpose.
  function wordSet(s) {
    var o = Object.create(null);
    s.split(" ").forEach(function (w) { if (w) o[w.toLowerCase()] = true; });
    return o;
  }
  // Stripped from the front of a run (and team nicknames from its end).
  var LEAD = wordSet(
    "carolina panthers panther arizona cardinals atlanta falcons baltimore ravens buffalo bills chicago bears " +
    "cincinnati bengals cleveland browns dallas cowboys denver broncos detroit lions green bay packers houston " +
    "texans indianapolis colts jacksonville jaguars kansas city chiefs las vegas oakland raiders los angeles " +
    "san diego chargers rams st. louis miami dolphins minnesota vikings new england patriots orleans saints york " +
    "giants jets philadelphia eagles pittsburgh steelers francisco 49ers seattle seahawks tampa buccaneers bucs " +
    "tennessee titans washington commanders redskins football team nfl nfc afc " +
    "quarterback qb running back rb fullback wide receiver wr tight end te offensive defensive lineman tackle " +
    "guard center centre linebacker outside inside middle cornerback safety free strong kicker punter long " +
    "snapper returner nose rookie veteran former legend alumnus alum head coach assistant coordinator general " +
    "manager owner owners president chairman mascot topcat topcats cheerleader cheerleaders captain " +
    "lb lbs olb ilb mlb cb cbs c dt de s t k p g ol dl db fs ss nt ls edge wrs rbs tes qbs " +
    "commissioner umpire referee official judge side line cowboy pathers new photo"
  );
  var TEAM_TAIL = wordSet(
    "panthers cardinals falcons ravens bills bears bengals browns cowboys broncos lions packers texans colts " +
    "jaguars chiefs raiders chargers rams dolphins vikings patriots saints giants jets eagles steelers 49ers " +
    "seahawks buccaneers titans commanders redskins"
  );
  // Capitalised function words are never part of a name; they end the run ("... Thomas Davis. The ...",
  // "Chris Harris Jr. He will ...", "Ryan Kalil No. 59").
  var FUNCTION_WORDS = wordSet(
    "the a an at in on during after before as with and from for of by to he she his her him they them their it " +
    "its this that these those we our you your no not but or so then when while who what where here there " +
    "if is was are were has have had"
  );
  // Any of these anywhere in a run means it is not a person.
  var REJECT = wordSet(
    "stadium field park arena center centre fame bowl super championship playoff playoffs game games " +
    "week season preseason camp training practice draft combine minicamp ota otas night weekend " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july " +
    "august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "bank america charlotte spartanburg wofford college university school elementary middle high academy " +
    "hospital health atrium novant children foundation club church community kids fans fan " +
    "keep pounding christmas thanksgiving halloween holiday holidays salute service military " +
    "nc n.c. s.c. ariz. fla. calif. ga. la. pa. tenn. mo. md. mich. n.j. n.y. ohio uptown county " +
    "photo photos gallery images credit ap getty usa today press associated studio " +
    "jersey jerseys uniform helmet logo flag anthem national ceremony parade festival fest event " +
    "state tech notre dame wake forest virginia dakota bison mountaineers baton rouge south bend chapel " +
    "east rutherford santa clara salt lake superdome dome wireless cable " +
    "voluntary workout workouts phase wild card trophy medal bronze operation freedom awareness month " +
    "american team man potato panthers carolina media family veterans memorial labor pro providence youth beach " +
    "catch crucial hail heart purple bowler ten gate lighting olympics edits energy teeter conference " +
    "award awards city army navy marines corps reserve battalion division " +
    "knights cougars tigers bulldogs ducks badgers buffaloes gamecocks heels hokies seminoles tide volunteers " +
    "aggies longhorns sooners buckeyes wolverines huskies trojans bruins hurricanes cavaliers deacons wildcats"
  );
  // Surnames as well as place or event words ("Aaron Hall" / "Hall of Fame", "Sheldon Day" / "Media Day"): a
  // run may end with one but not contain one anywhere else.
  var NOT_BEFORE_LAST = wordSet("hall day");
  // A run that starts with one of these is a place ("North Gate", "Central Michigan", "Fort Bragg").
  var NOT_FIRST = wordSet("north south east west central northern southern eastern western fort mount mt.");
  // Two-word places around Charlotte that look exactly like names in captions ("... / Rock Hill, S.C.").
  var PLACE_NAMES = wordSet("rock_hill indian_trail high_point concord_mills lake_norman mint_hill");
  var RE_SHOUT = /^[A-Z]{3,}$/;   // "JASON E. MICZEK" (a photo credit), "JMA Wireless Dome"
  var RE_NAME_WORD = /^(?:[A-Z][a-z]*\.?(?:[A-Z]\.?)*|[A-Z][A-Za-z]*(?:['\u2019-][A-Za-z]+)*|[A-Z][a-z]*[A-Z][a-z]+)$/;
  var RE_SUFFIX = /^(?:Jr\.?|Sr\.?|II|III|IV)$/;
  // Name particles: a run holding one is a single name ("Brian De La Puente"), never two neighbours.
  var PARTICLES = wordSet("de la le da di du del della van von der den st. st");
  var RE_ABBR = /^[A-Z]{1,3}$/;   // "QB", "WR", "DL": with LEAD, never the end of a name ("Oregon QB")
  // A jersey number right after a run ("Chris Draft (52)", "Tetairoa McMillan #4") marks it as a person, so a
  // surname that is also a REJECT word (Draft, Wake, Gallery, Saturday) survives. NUMBER stands in for it.
  var NUMBER = "\u0002";
  var RE_JERSEY = /\s*(?:\(\d{1,2}\)|#\d{1,2}\b)/g;
  var RE_CREDIT = /\([^)]*\)|#\d+/g;
  // A photo credit runs to the end of the caption ("Photo by Kent Gidley", "Courtesy of ...").
  var RE_CREDIT_TAIL = /\b(?:photos? (?:by|courtesy)|courtesy of|credit:)[\s\S]*$/i;
  // Punctuation stays attached to its word: a word ending in , . ; : closes the run ("Glendale, Ariz." is two
  // one-word runs, not the name "Glendale Ariz").
  var RE_SPLIT = /[\s"\u201c\u201d]+/;
  var RE_RUN_END = /[.,;:!?]$/;
  var RE_INITIAL = /^(?:[A-Z]\.){1,2}$|^[A-Z]\.[A-Z]$|^St\.$/;
  var RE_POSSESSIVE = /['\u2019]s$/;

  function nameRuns(caption) {
    var text = caption.replace(RE_JERSEY, " " + NUMBER + " ").replace(RE_CREDIT, " , ").replace(RE_CREDIT_TAIL, "");
    var ws = text.split(RE_SPLIT), runs = [], cur = [];
    for (var i = 0; i <= ws.length; i++) {
      var w = i < ws.length ? ws[i] : "";
      if (w === NUMBER) {
        if (cur.length) { cur.numbered = true; runs.push(cur); }
        cur = [];
        continue;
      }
      // "Todd Van Emst/AU Athletics": a name glued to an organisation is a credit, not a subject. A bare "/"
      // between two names only separates them.
      if (w.indexOf("/") !== -1 && w !== "/") { cur = []; continue; }
      var end = RE_RUN_END.test(w) && !RE_SUFFIX.test(w) && !RE_INITIAL.test(w);
      var core = end ? w.slice(0, -1) : w;
      if (RE_POSSESSIVE.test(core)) { core = core.slice(0, -2); end = true; }
      if (core && !FUNCTION_WORDS[core.toLowerCase()] && (RE_NAME_WORD.test(core) || (cur.length && RE_SUFFIX.test(core)))) {
        cur.push(core);
        if (end) { runs.push(cur); cur = []; }
      } else {
        // "Tom Benson Hall of Fame Stadium": Hall / Day before "of" is the start of a place or event name.
        if (core.toLowerCase() === "of" && cur.length && NOT_BEFORE_LAST[cur[cur.length - 1].toLowerCase()]) cur.pop();
        if (cur.length) runs.push(cur);
        cur = [];
      }
    }
    return runs;
  }

  // numbered: the run was followed by a jersey number, so its last word may be a REJECT word ("Chris Draft").
  function validName(run, numbered) {
    if (run.length < 2 || run.length > 4 || RE_SUFFIX.test(run[0]) || NOT_FIRST[run[0].toLowerCase()]) return "";
    for (var i = 0; i < run.length; i++) {
      var low = run[i].toLowerCase(), last = i === run.length - 1;
      if ((REJECT[low] && !(last && numbered)) || (NOT_BEFORE_LAST[low] && !last)) return "";
      if (LEAD[low] && !PARTICLES[low] && (!last || RE_ABBR.test(run[i])) && !RE_SUFFIX.test(run[i + 1] || "")) return "";
      if (RE_SHOUT.test(run[i]) && !RE_SUFFIX.test(run[i])) return "";
    }
    return PLACE_NAMES[run.join("_").toLowerCase()] ? "" : run.join(" ");
  }

  // The names in one run: usually one, but captions list neighbours without punctuation ("Jadeveon Clowney
  // Bryce Young 241024 practice"), so a 4- or 6-word run is read as two-word names - unless it has a suffix or
  // a particle (one long name), or any word that is not part of a name (then it is a place or an event, and
  // none of it is kept: "Mercedes Benz Super Dome" is not "Mercedes Benz").
  function cleanRun(run) {
    var a = 0, b = run.length, numbered = !!run.numbered;
    while (a < b && LEAD[run[a].toLowerCase()]) a++;
    while (b > a && TEAM_TAIL[run[b - 1].toLowerCase()]) { b--; numbered = false; }
    run = run.slice(a, b);
    var single = run.some(function (w) { return RE_SUFFIX.test(w) || PARTICLES[w.toLowerCase()]; });
    if (!single && (run.length === 4 || run.length === 6)) {
      if (run.some(function (w) { return REJECT[w.toLowerCase()]; })) return [];
      var out = [];
      for (var i = 0; i < run.length; i += 2) {
        var pair = validName(run.slice(i, i + 2), numbered && i === run.length - 2);
        if (pair) out.push(pair);
      }
      return out;
    }
    var name = validName(run, numbered);
    return name ? [name] : [];
  }

  function extractPeople(captions) {
    var counts = new Map(), order = [];
    (captions || []).forEach(function (c) {
      var inCaption = {};
      nameRuns(String(c || "")).forEach(function (run) {
        cleanRun(run).forEach(function (name) {
          var key = name.toLowerCase();
          if (inCaption[key]) return;
          inCaption[key] = true;
          if (!counts.has(key)) { counts.set(key, { name: name, n: 0, first: order.length }); order.push(key); }
          counts.get(key).n++;
        });
      });
    });
    return order.map(function (k) { return counts.get(k); })
      .sort(function (x, y) { return y.n - x.n || x.first - y.first; })
      .slice(0, PEOPLE_MAX)
      .map(function (x) { return x.name; });
  }

  // ── Index normalisation ─────────────────────────────────────────────────────────────────────────
  function withSlash(s) { return s.slice(-1) === "/" ? s : s + "/"; }

  function strings(list) {
    var out = [];
    if (Array.isArray(list)) for (var i = 0; i < list.length; i++) if (typeof list[i] === "string" && list[i]) out.push(list[i]);
    return out;
  }

  function normalizeIndex(json) {
    var base = { url: DEFAULT_BASE.url, thumb: DEFAULT_BASE.thumb };
    var list = [], version = 0;
    if (json && Array.isArray(json.galleries)) {
      list = json.galleries; version = json.version || 1;
      if (json.base && typeof json.base === "object") {
        var bu = PVI.originUrl(json.base.url, GALLERY_ORIGIN);
        var bt = PVI.originUrl(json.base.thumb, THUMB_ORIGIN);
        if (bu) base.url = withSlash(bu);
        if (bt) base.thumb = withSlash(bt);
      }
    }
    var galleries = [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== "object" || !raw.slug) continue;
      var slug = String(raw.slug).replace(/^\/+|\/+$/g, "");
      if (!slug || slug.indexOf("/") !== -1 || isCategorySlug(slug)) continue;
      var title = cleanGalleryTitle(raw.title);
      if (!title) continue;
      var n = typeof raw.n === "number" ? raw.n : parseInt(raw.n, 10);
      // Unlike a video entry, a gallery thumb must be on the thumbnail origin even when given as a full URL.
      var thumb = PVI.thumbUrl(raw.thumb, base.thumb);
      galleries.push({
        title: title,
        url: base.url + encodeURI(slug),
        date: raw.date ? String(raw.date) : "",
        thumb: thumb && thumb.indexOf(THUMB_ORIGIN + "/") === 0 ? thumb : "",
        desc: raw.desc ? PVI.cleanText(raw.desc).slice(0, DESC_MAX) : "",
        tags: strings(raw.tags),
        people: strings(raw.people),
        n: n > 0 ? Math.round(n) : 0,
        slug: slug
      });
    }
    return { version: version, base: base, galleries: galleries };
  }

  // ── Live merge ──────────────────────────────────────────────────────────────────────────────────
  // On panthers.com the widget reads the feed's first page at load (same origin) so a gallery published since
  // the index was last rebuilt is searchable at once by its title and description. Feed cards carry no tags,
  // people or photo count, so an indexed gallery keeps those and only takes the card's newer text.
  function mergeFresh(galleries, cards) {
    var fresh = normalizeIndex({ version: 1, galleries: cards || [] }).galleries;
    if (!fresh.length) return { galleries: galleries, added: 0, updated: 0 };
    var bySlug = {}, i;
    for (i = 0; i < fresh.length; i++) bySlug[fresh[i].slug] = fresh[i];
    var out = [], updated = 0;
    for (i = 0; i < galleries.length; i++) {
      var g = galleries[i], f = g.slug && bySlug[g.slug];
      if (f) {
        var m = {
          title: f.title, url: g.url, date: f.date || g.date, thumb: f.thumb || g.thumb, desc: f.desc || g.desc,
          tags: g.tags, people: g.people, n: g.n, slug: g.slug
        };
        if (m.title !== g.title || m.date !== g.date || m.thumb !== g.thumb || m.desc !== g.desc) { updated++; out.push(m); }
        else out.push(g);
        delete bySlug[g.slug];
      } else {
        out.push(g);
      }
    }
    var added = 0;
    for (i = 0; i < fresh.length; i++) {
      if (bySlug[fresh[i].slug]) { out.push(fresh[i]); added++; }
    }
    return { galleries: out, added: added, updated: updated };
  }

  return {
    version: "1.0.0",
    DEFAULT_BASE: DEFAULT_BASE,
    FEED_MAX: FEED_MAX,
    CAT_SLUGS: CAT_SLUGS,
    LISTINGS: LISTINGS,
    isCategorySlug: isCategorySlug,
    slugFromUrl: slugFromUrl,
    feedUrl: feedUrl,
    hasNextPage: hasNextPage,
    parseCards: parseCards,
    parseGalleryPage: parseGalleryPage,
    cleanTags: cleanTags,
    galleryDesc: galleryDesc,
    isCaption: isCaption,
    extractPeople: extractPeople,
    cleanGalleryTitle: cleanGalleryTitle,
    cardDate: cardDate,
    normalizeIndex: normalizeIndex,
    mergeFresh: mergeFresh
  };
}));
