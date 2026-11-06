/*!
 * PanthersSiteIndex — data rules for the site search (KIND "site"): parsing the site's news / podcast feeds,
 * roster, coaches, Hall of Honor and menus, the host allowlist for every link it shows, normalising the two
 * published files, and matching the "Go to" rows. No DOM, no dependencies beyond PanthersVideoIndex
 * (src/index-normalize.js) and PanthersPhotoIndex (src/photo-index.js).
 *
 * Browser: window.PanthersSiteIndex   Node: module.exports
 *
 *   feedUrl(section, skip, count)  section "stories" | "audio" -> "/api/lazy/load?json=..." (count <= FEED_MAX)
 *   parseCards(html, section)      -> [{ slug, title, date, thumb, desc }]      (one feed page)
 *   parseRoster(html)              -> { players: [{ slug, title, num, pos, college, status }], active: bool }
 *   parseCoaches(html)             -> [{ slug, title, role }]
 *   parseHallOfHonor(html)         -> [{ slug, title, year }]
 *   parseMenus(html)               -> [{ url, title }]   header / footer links on allowed hosts, in page order
 *   allowedUrl(u)                  -> canonical https URL on an allowed host (see ALLOWED), or ""
 *   normalizeGoto(json)            -> { entries: [{ type, title, url, aliases, sub, order }], quick: [entry],
 *                                       synonyms: [[...]] }
 *   normalizeArchive(json)         -> { stories: [item], audio: [item] }  items in the engine's shape
 *   gotoMatcher(entries, PVS, opts) -> function (query) -> up to 3 entries
 *
 * The published files (written by tools/build-site-index.js, hourly in the index repo):
 *   site-goto.json  { version: 1, generated, pages: [{ url, title, aliases }], players: [...], coaches: [...],
 *                     legends: [...], quick: [page url], synonyms: [[...]] }                  (a few KB)
 *   site.json       { version: 1, generated, fullAt, stories: [{ slug, title, date, thumb, desc }], audio: [...] }
 *
 * Every link the widget renders is built here: pages must pass allowedUrl (an allowlist in this code, never in
 * the data, so the data cannot point a "Go to" row anywhere else); stories, podcasts, players, coaches and
 * legends are slugs under the fixed panthers.com origin; thumbnails go through PanthersVideoIndex.thumbUrl.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./index-normalize.js"), require("./photo-index.js"));
  } else {
    root.PanthersSiteIndex = factory(root.PanthersVideoIndex, root.PanthersPhotoIndex);
  }
}(typeof window !== "undefined" ? window : this, function (PVI, PPI) {
  "use strict";

  var ORIGIN = "https://www.panthers.com";
  var THUMB_BASE = "https://static.clubs.nfl.com/image/";
  var FEED_MAX = 100;              // the feed silently returns 25 items for any Count above 100 (as for galleries)
  var DESC_MAX = 300;              // podcast summaries run to ~520 characters; stories to ~280
  var TITLE_MAX = 160;
  var GOTO_SHOWN = 3;
  var SECTIONS = {
    stories: { type: "stories", path: "/news/" },
    audio: { type: "audios", path: "/audio/" }
  };

  // Hosts a "Go to" page may link to, each with the path its URLs must start with. Everything else is dropped,
  // whatever the data says: the menus also link to 31 other clubs, social sites, affiliate and tracking links.
  var ALLOWED = {
    "www.panthers.com": "/",
    "www.bankofamericastadium.com": "/",
    "shop.panthers.com": "/",
    "am.ticketmaster.com": "/panthers/",
    "lostandfoundreport.com": "/bankofamericastadium"
  };

  var RE_TAG = /<[^>]*>/g;
  var RE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
  var RE_CARD = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  var RE_HREF = /\bhref="([^"]*)"/;
  var RE_TITLE_ATTR = /\btitle="([^"]*)"/;
  var RE_CARD_TITLE = /class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/;
  var RE_CARD_DATE_EL = /class="[^"]*__date[^"]*"[^>]*>([\s\S]*?)<\/p>/;
  var RE_CARD_SUMMARY = /class="[^"]*__summary[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/;
  var RE_CLOUDINARY = new RegExp("https://static\\.clubs\\.nfl\\.com/image/(?:upload|private)/[^\"'\\s,]*?/panthers/[A-Za-z0-9_-]+", "i");

  function str(s) { return s == null ? "" : String(s); }

  function htmlText(s) {
    return PVI.cleanText(PVI.decodeHtml(str(s).replace(RE_TAG, " ")));
  }

  function truncate(s, max) {
    if (s.length <= max) return s;
    var cut = s.slice(0, max - 1), sp = cut.lastIndexOf(" ");
    if (sp > max / 2) cut = cut.slice(0, sp);
    return cut.replace(/[ ,;:.\-\u2013\u2014]+$/, "") + "\u2026";
  }

  // "TICKETS" -> "Tickets", "PSL Hub" stays. Menu labels are often all caps.
  function labelCase(s) {
    s = PVI.cleanText(s);
    if (s !== s.toUpperCase() || !/[A-Z]{2}/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s\-&\/])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  // ── URLs ──────────────────────────────────────────────────────────────────────────────────────
  // https, host on ALLOWED and under its path, no query, no hash. A trailing slash is kept as given: panthers.com
  // serves some pages at "/x/" (and redirects "/x") and others at "/x" (and redirects "/x/"), so only the source
  // knows which; urlKey() compares URLs without it.
  function allowedUrl(u, base) {
    if (typeof u !== "string" || !u.trim()) return "";
    var x;
    try { x = new URL(u.trim(), base || ORIGIN + "/"); } catch (e) { return ""; }
    if (x.protocol !== "https:" || x.username || x.password || x.port) return "";
    var host = x.hostname.toLowerCase(), need = ALLOWED[host];
    if (!need) return "";
    var p = (x.pathname || "/").replace(/\/{2,}/g, "/");
    var bare = p.replace(/\/+$/, "") || "/", root = need.replace(/\/+$/, "");   // root "" for "/": the whole host
    if (root && bare !== root && bare.indexOf(root + "/") !== 0) return "";
    return "https://" + host + p;
  }

  // Same page, whatever the trailing slash: "https://www.panthers.com/tickets" and ".../tickets/" are one key.
  function urlKey(u) { return String(u).replace(/\/+$/, ""); }

  function slugOk(s) { return typeof s === "string" && s.length <= 200 && RE_SLUG.test(s); }

  function sectionOf(name) {
    var s = SECTIONS[name];
    if (!s) throw new Error("unknown section " + name);
    return s;
  }

  // The module config the site's lazyloadmore.js sends for an untagged list ("stories" = news, "audios" = podcasts).
  function feedUrl(section, skip, count) {
    var s = sectionOf(section);
    count = Math.max(1, Math.min(FEED_MAX, count | 0 || FEED_MAX));
    var cfg = {
      Name: "EditorialList",
      Module: {
        View: "Card async", ShowDate: true, HideDescription: false, MoreLink: "#load-more",
        ExtraClass: "d3-is-lazy-load-more", Selection: null, Type: s.type, Tags: null,
        Skip: Math.max(0, skip | 0), Count: count
      }
    };
    return "/api/lazy/load?json=" + encodeURIComponent(JSON.stringify(cfg));
  }

  // Slug of a /news/<slug> or /audio/<slug> link on panthers.com, or "".
  function slugIn(href, path) {
    var abs = PVI.httpUrl(PVI.decodeHtml(href), ORIGIN + "/");
    if (!abs || abs.indexOf(ORIGIN + path) !== 0) return "";
    var rest = abs.slice((ORIGIN + path).length).split(/[?#]/)[0].replace(/\/+$/, "");
    return slugOk(rest) ? rest : "";
  }

  // ── Feed cards ──────────────────────────────────────────────────────────────────────────────────
  // One feed page (the HTML /api/lazy/load returns). A card whose link is not in the section, or that has no
  // title, is skipped; garbage input returns [].
  function parseCards(html, section) {
    var s = sectionOf(section), out = [], seen = {};
    if (typeof html !== "string" || html.indexOf("<a") === -1) return out;
    RE_CARD.lastIndex = 0;
    var m;
    while ((m = RE_CARD.exec(html))) {
      var attrs = m[1], body = m[2];
      var href = RE_HREF.exec(attrs);
      if (!href) continue;
      var slug = slugIn(href[1], s.path);
      if (!slug || seen[slug]) continue;
      var tm = RE_CARD_TITLE.exec(body), ta = RE_TITLE_ATTR.exec(attrs);
      // cleanText, not cleanTitle: that one drops a leading "Video ", right for videos.json, wrong for a news title.
      var title = truncate(PVI.cleanText(tm ? htmlText(tm[1]) : (ta ? PVI.decodeHtml(ta[1]) : "")), TITLE_MAX);
      if (!title) continue;
      seen[slug] = true;
      var e = { slug: slug, title: title };
      var dm = RE_CARD_DATE_EL.exec(body);
      var date = dm ? PPI.cardDate(htmlText(dm[1])) : "";
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

  // ── Roster, coaches, Hall of Honor ──────────────────────────────────────────────────────────────
  var RE_ROSTER_PART = /<caption[^>]*>([\s\S]*?)<\/caption>|<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>|<tr[^>]*>([\s\S]*?)<\/tr>/g;
  var RE_TD = /<td[^>]*>([\s\S]*?)<\/td>/g;
  var RE_PLAYER_HREF = /href="\/team\/players-roster\/([a-z0-9-]+)\/?"/;
  var STATUSES = { "active": "Active", "reserve/injured": "Injured Reserve", "reserve/physically unable to perform": "PUP",
                   "practice squad": "Practice Squad", "reserve/non-football injury": "NFI", "reserve/suspended": "Suspended" };

  // The roster page's tables: Player, #, Pos, HT, WT, Age, Exp, College, under "Active", "Reserve/Injured", ...
  function parseRoster(html) {
    var players = [], seen = {}, status = "", active = false;
    if (typeof html !== "string") return { players: players, active: false };
    RE_ROSTER_PART.lastIndex = 0;
    var m;
    while ((m = RE_ROSTER_PART.exec(html))) {
      if (m[1] != null || m[2] != null) {
        var h = htmlText(m[1] != null ? m[1] : m[2]).toLowerCase();
        if (STATUSES[h]) { status = STATUSES[h]; if (h === "active") active = true; }
        continue;
      }
      var row = m[3], ph = RE_PLAYER_HREF.exec(row);
      if (!ph || seen[ph[1]] || !slugOk(ph[1])) continue;
      var cells = [], c;
      RE_TD.lastIndex = 0;
      while ((c = RE_TD.exec(row))) cells.push(htmlText(c[1]));
      var name = cells[0] || "";
      if (!name || name.length > 60) continue;
      seen[ph[1]] = true;
      var p = { slug: ph[1], title: name };
      if (/^\d{1,2}$/.test(cells[1] || "")) p.num = +cells[1];
      if (/^[A-Z]{1,4}$/.test(cells[2] || "")) p.pos = cells[2];
      if (cells[7] && cells[7].length <= 60) p.college = cells[7];
      if (status) p.status = status;
      players.push(p);
    }
    return { players: players, active: active };
  }

  var RE_PERSON_LINK = /<a\b[^>]*href="\/team\/(coaches-roster|hall-of-honor)\/([a-z0-9-]+)\/?"[^>]*>([\s\S]*?)<\/a>/g;

  function personLinks(html, which) {
    var out = [];
    if (typeof html !== "string") return out;
    RE_PERSON_LINK.lastIndex = 0;
    var m;
    while ((m = RE_PERSON_LINK.exec(html))) if (m[1] === which && slugOk(m[2]) && m[2] !== "index") out.push({ slug: m[2], text: htmlText(m[3]) });
    return out;
  }

  function titleFromSlug(slug) {
    return slug.split("-").map(function (w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }).join(" ");
  }

  // Coaching staff page: one card (div.d3-o-media-object) per coach, holding the name (h3 ...__title), the role
  // (h5 ...__roofline) and a link to /team/coaches-roster/<slug> - wrapped round them on a headshot card, after
  // them ("Profile") on the head coach's featured card. A card without a title falls back to the slug's words.
  var RE_COACH_CARD = /<div class="d3-o-media-object[\s"]/g;
  var RE_COACH_HREF = /href="\/team\/coaches-roster\/([a-z0-9-]+)\/?"/;
  var RE_CARD_H3 = /class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\/h\d>/;
  var RE_CARD_ROOF = /class="[^"]*__roofline[^"]*"[^>]*>([\s\S]*?)<\/h\d>/;

  function parseCoaches(html) {
    var out = [], seen = {}, starts = [], m;
    if (typeof html !== "string") return out;
    RE_COACH_CARD.lastIndex = 0;
    while ((m = RE_COACH_CARD.exec(html))) starts.push(m.index);
    for (var i = 0; i < starts.length; i++) {
      var card = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length);
      var h = RE_COACH_HREF.exec(card);
      if (!h || !slugOk(h[1]) || h[1] === "index" || seen[h[1]]) continue;
      var tm = RE_CARD_H3.exec(card), rm = RE_CARD_ROOF.exec(card);
      var title = tm ? htmlText(tm[1]) : titleFromSlug(h[1].replace(/-\d+$/, ""));
      if (!title || title.length > 60) continue;
      seen[h[1]] = true;
      var e = { slug: h[1], title: title }, role = rm ? htmlText(rm[1]) : "";
      if (role && role.length <= 80) e.role = role;
      out.push(e);
    }
    return out;
  }

  // Hall of Honor page: "<a href=/team/hall-of-honor/steve-smith-sr>Steve Smith, Sr. (2019)</a>".
  function parseHallOfHonor(html) {
    var out = [], seen = {};
    personLinks(html, "hall-of-honor").forEach(function (l) {
      if (seen[l.slug]) return;
      var m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(l.text);
      var title = PVI.cleanText(m ? m[1] : l.text);
      if (!title || title.length > 60) return;
      seen[l.slug] = true;
      var e = { slug: l.slug, title: title };
      if (m) e.year = +m[2];
      out.push(e);
    });
    return out;
  }

  // ── Menus ───────────────────────────────────────────────────────────────────────────────────────
  var RE_A = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  var RE_LINK_NAME = /\bdata-link_name="([^"]*)"/;
  var SKIP_LABELS = { "nav logo": 1, "carolina panthers": 1, "panthers": 1, "": 1 };

  // Links inside the page's <header> and <footer> (the site's menus), on allowed hosts, labelled by the menu
  // text. The homepage itself and duplicates are dropped; the first label of a URL wins.
  function parseMenus(html) {
    var out = [], seen = {};
    if (typeof html !== "string") return out;
    var parts = [], re = /<(header|footer)\b[^>]*>([\s\S]*?)<\/\1>/g, m;
    while ((m = re.exec(html))) parts.push(m[2]);
    parts.forEach(function (part) {
      RE_A.lastIndex = 0;
      var a;
      while ((a = RE_A.exec(part))) {
        var href = RE_HREF.exec(a[1]);
        if (!href) continue;
        var url = allowedUrl(PVI.decodeHtml(href[1]));
        if (!url || urlKey(url) === ORIGIN || seen[urlKey(url)]) continue;
        var ln = RE_LINK_NAME.exec(a[1]), ta = RE_TITLE_ATTR.exec(a[1]);
        var label = labelCase(htmlText(ln ? ln[1] : (ta ? ta[1] : a[2])));
        if (SKIP_LABELS[label.toLowerCase()] || label.length > 60) continue;
        seen[urlKey(url)] = true;
        out.push({ url: url, title: label });
      }
    });
    return out;
  }

  // ── Normalising the published files (widget side) ─────────────────────────────────────────────
  var SUBJECT_MAX = 80, ALIASES_MAX = 24, ALIAS_MAX = 60;

  function cleanAliases(list) {
    var out = [], seen = {};
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < ALIASES_MAX; i++) {
      var a = PVI.cleanText(str(list[i]));
      if (!a || a.length > ALIAS_MAX || seen[a.toLowerCase()]) continue;
      seen[a.toLowerCase()] = true;
      out.push(a);
    }
    return out;
  }

  function cleanSynonyms(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 200; i++) {
      var g = cleanAliases(list[i]);
      if (g.length >= 2) out.push(g.slice(0, 8));
    }
    return out;
  }

  function personEntry(type, x, path, sub, order) {
    if (!x || !slugOk(x.slug)) return null;
    var title = PVI.cleanText(str(x.title));
    if (!title || title.length > SUBJECT_MAX) return null;
    return { type: type, title: title, url: ORIGIN + path + x.slug + "/", aliases: cleanAliases(x.aliases), sub: sub, order: order };
  }

  function playerSub(p) {
    var bits = [];
    if (typeof p.pos === "string" && /^[A-Z]{1,4}$/.test(p.pos)) bits.push(p.pos);
    if (typeof p.num === "number" && p.num >= 0 && p.num < 100) bits.push("#" + p.num);
    var s = bits.join(" ");
    if (typeof p.college === "string" && p.college && p.college.length <= 60) s += (s ? " \u00b7 " : "") + PVI.cleanText(p.college);
    if (typeof p.status === "string" && p.status && p.status !== "Active" && p.status.length <= 30) s += (s ? " \u00b7 " : "") + p.status;
    return "Player" + (s ? " \u00b7 " + s : "");
  }

  function normalizeGoto(json) {
    var entries = [], order = 0, seenUrl = {};
    function add(e) { if (e && !seenUrl[urlKey(e.url)]) { seenUrl[urlKey(e.url)] = true; entries.push(e); } }
    if (json && typeof json === "object") {
      (Array.isArray(json.pages) ? json.pages : []).forEach(function (p) {
        if (!p) return;
        var url = allowedUrl(str(p.url)), title = PVI.cleanText(str(p.title));
        if (!url || !title || title.length > SUBJECT_MAX) return;
        add({ type: "page", title: title, url: url, aliases: cleanAliases(p.aliases), sub: "", order: order++ });
      });
      (Array.isArray(json.players) ? json.players : []).forEach(function (p) {
        add(personEntry("player", p, "/team/players-roster/", p ? playerSub(p) : "", order++));
      });
      (Array.isArray(json.coaches) ? json.coaches : []).forEach(function (c) {
        var role = c && typeof c.role === "string" && c.role.length <= 80 ? PVI.cleanText(c.role) : "";
        add(personEntry("coach", c, "/team/coaches-roster/", "Coach" + (role ? " \u00b7 " + role : ""), order++));
      });
      (Array.isArray(json.legends) ? json.legends : []).forEach(function (l) {
        var y = l && typeof l.year === "number" && l.year > 1990 && l.year < 2100 ? " \u00b7 " + l.year : "";
        add(personEntry("legend", l, "/team/hall-of-honor/", "Hall of Honor" + y, order++));
      });
    }
    // "Popular Pages": the listed page URLs, in that order, as the entries above (so the same gating applies).
    var quick = [], byKey = {};
    entries.forEach(function (e) { if (e.type === "page") byKey[urlKey(e.url)] = e; });
    (json && Array.isArray(json.quick) ? json.quick : []).forEach(function (u) {
      var e = byKey[urlKey(allowedUrl(str(u)))];
      if (e && quick.indexOf(e) === -1) quick.push(e);
    });
    return { entries: entries, quick: quick, synonyms: cleanSynonyms(json && json.synonyms) };
  }

  // Like a gallery's, a story or podcast thumbnail must be on the thumbnail origin even when given as a full URL.
  function thumbIn(t) {
    var u = t ? PVI.thumbUrl(str(t), THUMB_BASE) : "";
    return u && u.indexOf(THUMB_BASE) === 0 ? u : "";
  }

  function archiveItems(list, section) {
    var s = SECTIONS[section], out = [], seen = {};
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || !slugOk(r.slug) || seen[r.slug]) continue;
      var title = PVI.cleanText(str(r.title));
      if (!title) continue;
      seen[r.slug] = true;
      var date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
      out.push({
        type: section === "stories" ? "story" : "audio",
        key: section + "/" + r.slug,
        // A podcast slug is a file name ("hhh234final-mp3"): its words would only add noise to the search.
        slug: section === "stories" ? r.slug : "",
        title: truncate(title, TITLE_MAX),
        desc: truncate(PVI.cleanText(str(r.desc)), DESC_MAX),
        date: date,
        thumb: thumbIn(r.thumb),
        url: ORIGIN + s.path + r.slug,
        tags: [], people: []
      });
    }
    return out;
  }

  function normalizeArchive(json) {
    if (!json || typeof json !== "object" || json.version !== 1) throw new Error("site.json: not a version 1 site index");
    return { stories: archiveItems(json.stories, "stories"), audio: archiveItems(json.audio, "audio") };
  }

  // Fresh cards from the live feed (parseCards output) merged over the archive list: new ones first, a known one
  // takes the feed's text. Returns { items, added, updated }.
  function mergeFresh(items, fresh, section) {
    var fresh2 = archiveItems(fresh, section);
    if (!fresh2.length) return { items: items, added: 0, updated: 0 };
    var byKey = {}, added = [], updated = 0;
    for (var i = 0; i < items.length; i++) byKey[items[i].key] = i;
    var out = items.slice();
    fresh2.forEach(function (f) {
      var at = byKey[f.key];
      if (at == null) { added.push(f); return; }
      var o = out[at];
      if (o.title !== f.title || o.desc !== f.desc || o.date !== f.date || (f.thumb && o.thumb !== f.thumb)) {
        out[at] = { type: o.type, key: o.key, slug: o.slug, title: f.title, desc: f.desc || o.desc, date: f.date || o.date,
                    thumb: f.thumb || o.thumb, url: o.url, tags: o.tags, people: o.people };
        updated++;
      }
    });
    return { items: added.concat(out), added: added.length, updated: updated };
  }

  // ── "Go to" matching ────────────────────────────────────────────────────────────────────────────
  // Words that name the whole site carry no meaning in a page title ("Panthers Official Roster" is "Roster").
  var GENERIC = { carolina: 1, panthers: 1, panther: 1, official: 1, home: 1, page: 1, panthers_com: 1, com: 1 };

  function words(PVS, s) {
    return PVS.tokenize(s).map(function (w) { return PVS.stem(w); }).filter(function (w) { return !GENERIC[w]; });
  }

  function containsRun(hay, needle) {
    if (!needle.length || needle.length > hay.length) return false;
    for (var i = 0; i + needle.length <= hay.length; i++) {
      var ok = true;
      for (var j = 0; j < needle.length && ok; j++) ok = hay[i + j] === needle[j];
      if (ok) return true;
    }
    return false;
  }

  // Up to GOTO_SHOWN entries for a query, best first:
  //   1. the query is exactly an entry's title or one of its aliases ("tickets", "smitty");
  //   2. every query word matches the entry (typos and nicknames through the engine, e.g. "bryse young"),
  //      fewest extra words first;
  //   3. a person's name, or a multi-word alias, appears inside a longer query ("jaycee horn injury").
  // Ties keep the data's order (menu order). When an entry and a page above it in the URL tree both match
  // ("/team/hall-of-honor" and "/team/hall-of-honor/sam-mills"), only the more specific one is kept.
  function gotoMatcher(entries, PVS, opts) {
    opts = opts || {};
    var docs = entries.map(function (e) {
      var keep = words(PVS, e.title).join(" ");
      return { title: keep ? e.title : "", tags: e.aliases.slice(), desc: "", slug: "", date: "", people: [], _e: e };
    });
    var engine = PVS.create(docs, { now: 0, synonyms: opts.synonyms, prefixMaxLen: 3 });
    // Per entry: its title's words and each alias's words. Inside a longer query a page needs a multi-word title
    // or alias ("season tickets" must not make every "... tickets" query a PSL row); a person also matches on a
    // curated one-word nickname ("smitty touchdown").
    var names = entries.map(function (e) {
      var list = [{ w: words(PVS, e.title), alias: false }];
      e.aliases.forEach(function (a) { list.push({ w: words(PVS, a), alias: true }); });
      return list;
    });
    return function (query) {
      var qw = words(PVS, query || "");
      if (!qw.length) return [];
      var qs = qw.join(" "), picks = new Map();
      function pick(i, rank, extra, score) {
        var cur = picks.get(i);
        if (!cur || rank < cur.rank || (rank === cur.rank && extra < cur.extra)) picks.set(i, { i: i, rank: rank, extra: extra, score: score || 0 });
      }
      entries.forEach(function (e, i) {
        names[i].forEach(function (n) {
          if (!n.w.length) return;
          if (n.w.join(" ") === qs) pick(i, 1, 0, 0);
          else if (qw.length > n.w.length && (n.w.length >= 2 || (n.alias && e.type !== "page")) && containsRun(qw, n.w)) {
            pick(i, 3, qw.length - n.w.length, 0);
          }
        });
      });
      // The engine gets the query without the site-wide words too ("panthers bryse young" -> "bryse young"), or
      // it would require "panthers" of every entry. Extra words count only against a name holding every query word
      // as a whole word, so a typo or prefix hit ("jones" -> "Fan Zone") sorts after an exact one (Patrick Jones II).
      var eq = PVS.tokenize(query || "").filter(function (w) { return !GENERIC[PVS.stem(w)]; }).join(" ");
      var res = eq ? engine.search(eq, { limit: 20 }) : { partial: true, results: [] };
      if (!res.partial) {
        res.results.forEach(function (r) {
          var i = docs.indexOf(r.video);
          if (i < 0) return;
          var best = Infinity;
          names[i].forEach(function (n) {
            if (n.w.length && qw.every(function (w) { return n.w.indexOf(w) >= 0; })) best = Math.min(best, Math.max(0, n.w.length - qw.length));
          });
          pick(i, 2, best === Infinity ? 99 : best, r.score);
        });
      }
      var list = Array.from(picks.values()).sort(function (a, b) {
        return a.rank - b.rank || a.extra - b.extra || b.score - a.score || entries[a.i].order - entries[b.i].order;
      }).map(function (p) { return entries[p.i]; });
      // A page gives way to one below it in the URL tree only when that one matched better, or as well through a
      // name in the query ("hall of honor sam mills" shows only Sam Mills). Two engine matches (rank 2) both hold
      // every query word, so the child adds nothing: "tikets" keeps /tickets/ next to /tickets/psls.
      var rankOf = new Map();
      picks.forEach(function (p) { rankOf.set(entries[p.i], p.rank); });
      var kept = list.filter(function (e) {
        return !list.some(function (o) {
          var ro = rankOf.get(o), re = rankOf.get(e);
          return o !== e && urlKey(o.url).indexOf(urlKey(e.url) + "/") === 0 && (ro < re || (ro === re && re !== 2));
        });
      });
      return kept.slice(0, GOTO_SHOWN);
    };
  }

  return {
    version: "1.0.0",
    ORIGIN: ORIGIN,
    FEED_MAX: FEED_MAX,
    DESC_MAX: DESC_MAX,
    SECTIONS: SECTIONS,
    ALLOWED: ALLOWED,
    allowedUrl: allowedUrl,
    urlKey: urlKey,
    feedUrl: feedUrl,
    parseCards: parseCards,
    parseRoster: parseRoster,
    parseCoaches: parseCoaches,
    parseHallOfHonor: parseHallOfHonor,
    parseMenus: parseMenus,
    labelCase: labelCase,
    normalizeGoto: normalizeGoto,
    normalizeArchive: normalizeArchive,
    mergeFresh: mergeFresh,
    gotoMatcher: gotoMatcher
  };
}));
