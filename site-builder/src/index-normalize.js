/*!
 * PanthersVideoIndex — index normalisation shared by the widget (src/widget.js) and the Node tests/bench
 * (tests/helpers.js). No DOM, no dependencies, ES2018. build.js inlines it between search-core.js and
 * widget.js.
 *
 * Browser: window.PanthersVideoIndex   Node: module.exports
 *
 *   PanthersVideoIndex.normalizeIndex(json)  -> { version, base, videos }
 *     json = format v2 ({ version, base, videos: [...] }) or the old v1 bare array of
 *     { title, url, date, thumb, desc }. Every entry becomes the engine's video object:
 *       { title, url, date, thumb (full https URL or ""), desc, tags: string[], dur: number, slug }
 *   PanthersVideoIndex.httpUrl(u, base)      -> resolved href for http(s) URLs only, else ""
 *   PanthersVideoIndex.thumbUrl(t, baseThumb)-> "upload/<id>" | "private/<id>" -> Cloudinary URL; https URLs as-is
 *   PanthersVideoIndex.slugFromUrl(url)      -> path after /video/ (no slashes), "" when absent
 *   PanthersVideoIndex.cleanTitle / cleanText / decodeHtml / isCategorySlug
 *
 * Security: every URL that can end up in an href/src is gated here. Index base URLs must be
 * https://www.panthers.com/ (videos) and https://static.clubs.nfl.com/ (thumbs) or they fall back to the
 * defaults; a v1 entry with a non-http(s) url is dropped; a non-https full-URL thumb becomes "".
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PanthersVideoIndex = factory();
  }
}(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var THUMB_TRANSFORM = "w_480,h_270,c_fill,g_auto,q_auto,f_auto";
  var DEFAULT_BASE = { url: "https://www.panthers.com/video/", thumb: "https://static.clubs.nfl.com/image/" };
  var VIDEO_ORIGIN = "https://www.panthers.com";
  var THUMB_ORIGIN = "https://static.clubs.nfl.com";
  var DESC_MAX = 400;
  // Built from a string: a regex literal containing "//" can be mangled by the CMS minifier (see build.js).
  var RE_T_LAZY = new RegExp("/t_lazy/", "gi");

  // Category/listing pages under /video/ that are NOT individual videos. This explicit denylist is the
  // only URL filter — the old ">= 3 hyphens" heuristic hid 555 real videos and must not come back.
  // "pressconferences" and "xs-and-os" are site-navigation links on the live /video page.
  var CAT_SLUGS = {};
  ["highlights", "blueprint", "interviews", "nfln", "archives", "panthers-fans", "panthers-huddle",
   "panthers-postgame", "social-video", "the-avenue", "lifestyle", "wired", "cart-talk", "mailbag",
   "gameday", "2021-confidential", "topcats", "all", "pressconferences", "xs-and-os"
  ].forEach(function (s) { CAT_SLUGS[s] = true; });

  function isCategorySlug(slug) {
    return Object.prototype.hasOwnProperty.call(CAT_SLUGS, String(slug).toLowerCase());
  }

  // ── Text ────────────────────────────────────────────────────────────────────────────────────────
  // v2 titles/descs are already unescaped by the builder; this only matters for v1 / page-scraped text.
  var ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
    hellip: "…", mdash: "—", ndash: "–", bull: "•", middot: "·",
    copy: "©", reg: "®", trade: "™", deg: "°", frac12: "½", times: "×",
    eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í", oacute: "ó",
    uacute: "ú", ntilde: "ñ", ccedil: "ç", uuml: "ü", ouml: "ö", auml: "ä",
    Eacute: "É", Ntilde: "Ñ"
  };

  function decodeHtml(s) {
    s = String(s == null ? "" : s);
    if (s.indexOf("&") === -1) return s;
    return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, function (m, body) {
      if (body.charAt(0) === "#") {
        var code = body.charAt(1) === "x" || body.charAt(1) === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!(code > 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
        return String.fromCodePoint(code);
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
    });
  }

  function cleanText(s) {
    return decodeHtml(s).replace(/[ \s]+/g, " ").trim();
  }

  function cleanTitle(s) {
    return cleanText(s).replace(/^video\s+/i, "");
  }

  // ── URLs ────────────────────────────────────────────────────────────────────────────────────────
  function parseUrl(u, base) {
    if (u == null) return null;
    u = String(u).trim();
    if (!u) return null;
    try { return new URL(u, base || DEFAULT_BASE.url); } catch (e) { return null; }
  }

  // Resolved href for http: / https: URLs only. Anything else (javascript:, data:, vbscript:, unparsable) -> "".
  function httpUrl(u, base) {
    var x = parseUrl(u, base);
    return x && (x.protocol === "http:" || x.protocol === "https:") ? x.href : "";
  }

  // https-only variant (thumbnails, og:image).
  function httpsUrl(u, base) {
    var x = parseUrl(u, base);
    return x && x.protocol === "https:" ? x.href : "";
  }

  // href when `u` is an ABSOLUTE URL on exactly `origin` (index base URLs), else "". Relative or
  // protocol-relative input is refused rather than resolved.
  function originUrl(u, origin) {
    if (typeof u !== "string" || !u.trim()) return "";
    try {
      var x = new URL(u.trim());
      return x.origin === origin ? x.href : "";
    } catch (e) { return ""; }
  }

  function slugFromUrl(url) {
    var x = parseUrl(url, DEFAULT_BASE.url);
    if (!x) return "";
    var p = x.pathname, i = p.indexOf("/video/");
    if (i === -1) return "";
    return p.slice(i + 7).replace(/^\/+|\/+$/g, "");
  }

  // Index thumb rule: "upload/<id>" | "private/<id>" -> Cloudinary URL with the widget transform (delivery
  // type preserved — private assets 404 under /upload/); a full URL is used as-is but must be https.
  function thumbUrl(t, baseThumb) {
    if (!t) return "";
    t = String(t).trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.indexOf("//") === 0) {
      return httpsUrl(t).replace(RE_T_LAZY, "/");
    }
    var i = t.indexOf("/");
    if (i <= 0) return "";
    var type = t.slice(0, i), id = t.slice(i + 1).replace(/^\/+/, "");
    if (!id || !/^[A-Za-z0-9_-]+$/.test(type)) return "";
    return httpsUrl((baseThumb || DEFAULT_BASE.thumb) + type + "/" + THUMB_TRANSFORM + "/panthers/" + id + ".jpg");
  }

  // ── Index normalisation ─────────────────────────────────────────────────────────────────────────
  function withSlash(s) { return s.slice(-1) === "/" ? s : s + "/"; }

  function normalizeIndex(json) {
    var base = { url: DEFAULT_BASE.url, thumb: DEFAULT_BASE.thumb };
    var list = [], version = 0;
    if (Array.isArray(json)) {
      list = json; version = 1;
    } else if (json && Array.isArray(json.videos)) {
      list = json.videos; version = json.version || 2;
      if (json.base && typeof json.base === "object") {
        // Anything not on the expected https origins (javascript:, other hosts, http:) falls back.
        var bu = originUrl(json.base.url, VIDEO_ORIGIN);
        var bt = originUrl(json.base.thumb, THUMB_ORIGIN);
        if (bu) base.url = withSlash(bu);
        if (bt) base.thumb = withSlash(bt);
      }
    }

    var videos = [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== "object") continue;
      var slug, url;
      if (raw.slug) {
        slug = String(raw.slug).replace(/^\/+|\/+$/g, "");
        url = base.url + slug;
      } else if (raw.url) {
        url = httpUrl(raw.url);          // v1: drop the entry unless the url is http(s)
        if (!url) continue;
        slug = slugFromUrl(url);
      } else {
        continue;
      }
      if (!slug || isCategorySlug(slug)) continue;
      var title = cleanTitle(raw.title);
      if (!title) continue;
      var tags = [];
      if (Array.isArray(raw.tags)) {
        for (var k = 0; k < raw.tags.length; k++) if (typeof raw.tags[k] === "string" && raw.tags[k]) tags.push(raw.tags[k]);
      }
      var dur = typeof raw.dur === "number" ? raw.dur : parseInt(raw.dur, 10);
      videos.push({
        title: title,
        url: url,
        date: raw.date ? String(raw.date) : "",
        thumb: thumbUrl(raw.thumb, base.thumb),
        desc: raw.desc ? cleanText(raw.desc).slice(0, DESC_MAX) : "",
        tags: tags,
        dur: dur > 0 ? Math.round(dur) : 0,
        slug: slug
      });
    }
    return { version: version, base: base, videos: videos };
  }

  // ── Live sitemap merge ───────────────────────────────────────────────────────────────────────────
  // The published index is rebuilt on a schedule, so the newest videos can be missing from it for a while.
  // On panthers.com the widget also reads the site's own "fast-changing" video sitemap (the latest ~100
  // videos, same origin, ~100 KB) and merges it in, so a video is searchable - with its tags, and therefore
  // under the tag-driven pills - as soon as the site lists it. These rules mirror build-index.py.
  var NOISE_TAGS = { "migrated": 1, "team": 1, "featured video": 1, "latest video": 1, "app video": 1,
                     "draft-tracker-card": 1, "nfl-draft-card": 1, "fr-hide": 1, "fr-live": 1 };
  var RE_URL_BLOCK = /<url\b[^>]*>([\s\S]*?)<\/url>/g;
  var RE_CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  var RE_INLINE_TAG = /<\/?(?:sup|sub|b|i|em|strong|u|span|small)\b[^>]*>/gi;
  var RE_ANY_TAG = /<\/?[A-Za-z][^>]*>/g;
  var RE_DATE = /^\d{4}-\d{2}-\d{2}/;
  var RE_THUMB = /^https?:\/\/static\.clubs\.nfl\.com\/image\/(upload|private)\/(?:[^?#]*?\/)?panthers\/([^\/?#]+?)(?:\.(?:jpe?g|png|gif|webp|avif))?(?:[?#].*)?$/i;

  function xmlText(s) {
    if (!s) return "";
    s = String(s).replace(RE_CDATA, "$1");
    s = decodeHtml(s);
    s = s.replace(RE_INLINE_TAG, "").replace(RE_ANY_TAG, " ");
    return cleanText(s);
  }

  function xmlField(block, name) {
    var esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var m = new RegExp("<" + esc + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + esc + ">").exec(block);
    return m ? xmlText(m[1]) : "";
  }

  function sitemapThumb(u) {
    var m = RE_THUMB.exec(u || "");
    if (m) return m[1].toLowerCase() + "/" + m[2];
    var s = String(u || "");
    return s.slice(0, 8).toLowerCase() === "https://" ? s : "";
  }

  function sitemapTags(raw) {
    var out = [], seen = {};
    var parts = raw ? raw.split(",") : [];
    for (var i = 0; i < parts.length; i++) {
      var t = cleanText(parts[i]);
      if (!t) continue;
      var low = t.toLowerCase();
      if (NOISE_TAGS[low] || low.indexOf("videochannel/") === 0) continue;
      if (/^[a-z0-9]+$/.test(t) && t.length > 10) continue;
      if (/^\d{4}-\d{6,}$/.test(t)) continue;
      if (seen[low]) continue;
      seen[low] = 1;
      out.push(t);
    }
    return out;
  }

  function truncateDesc(s) {
    if (s.length <= DESC_MAX) return s;
    var cut = s.slice(0, DESC_MAX - 1), sp = cut.lastIndexOf(" ");
    if (sp > DESC_MAX / 2) cut = cut.slice(0, sp);
    return cut.replace(/[ ,;:.\-\u2013\u2014]+$/, "") + "\u2026";
  }

  // Parse a video sitemap into format-v2 entries ({slug, title, date, thumb, desc, tags, dur}). Tolerant of
  // anything unexpected: a block that yields no slug or title is skipped, and garbage input returns [].
  function parseSitemap(xml) {
    var out = [];
    if (typeof xml !== "string" || xml.indexOf("<url") === -1) return out;
    RE_URL_BLOCK.lastIndex = 0;
    var m;
    while ((m = RE_URL_BLOCK.exec(xml))) {
      var block = m[1];
      var slug = slugFromUrl(xmlField(block, "loc"));
      if (!slug || isCategorySlug(slug)) continue;
      var title = xmlField(block, "video:title");
      if (!title) continue;
      var pub = xmlField(block, "video:publication_date");
      if (!RE_DATE.test(pub)) pub = xmlField(block, "lastmod");
      var e = { slug: slug, title: title, date: RE_DATE.test(pub) ? pub.slice(0, 10) : "" };
      var thumb = sitemapThumb(xmlField(block, "video:thumbnail_loc"));
      if (thumb) e.thumb = thumb;
      var desc = truncateDesc(xmlField(block, "video:description"));
      if (desc) e.desc = desc;
      var tags = sitemapTags(xmlField(block, "video:tag"));
      if (tags.length) e.tags = tags;
      var durRaw = xmlField(block, "video:duration");
      if (/^\d+$/.test(durRaw) && +durRaw > 0) e.dur = +durRaw;
      out.push(e);
    }
    return out;
  }

  // Merge fresh sitemap entries into a normalised video list. The sitemap is the same source the index is
  // built from, only newer, so it replaces an entry with the same slug and adds videos the index lacks.
  // Returns { videos, added, updated } without mutating the input list.
  function mergeFresh(videos, freshV2) {
    var fresh = normalizeIndex({ version: 2, videos: freshV2 || [] }).videos;
    if (!fresh.length) return { videos: videos, added: 0, updated: 0 };
    var bySlug = {}, i;
    for (i = 0; i < fresh.length; i++) bySlug[fresh[i].slug] = fresh[i];
    var out = [], updated = 0;
    for (i = 0; i < videos.length; i++) {
      var v = videos[i], f = v.slug && bySlug[v.slug];
      if (f) {
        if (f.title !== v.title || f.tags.join("|") !== v.tags.join("|") || f.date !== v.date || f.thumb !== v.thumb) updated++;
        out.push(f);
        delete bySlug[v.slug];
      } else {
        out.push(v);
      }
    }
    var added = 0;
    for (i = 0; i < fresh.length; i++) {
      if (bySlug[fresh[i].slug]) { out.push(fresh[i]); added++; }
    }
    return { videos: out, added: added, updated: updated };
  }

  return {
    version: "1.0.0",
    THUMB_TRANSFORM: THUMB_TRANSFORM,
    RE_T_LAZY: RE_T_LAZY,
    DEFAULT_BASE: DEFAULT_BASE,
    VIDEO_ORIGIN: VIDEO_ORIGIN,
    THUMB_ORIGIN: THUMB_ORIGIN,
    CAT_SLUGS: CAT_SLUGS,
    isCategorySlug: isCategorySlug,
    parseSitemap: parseSitemap,
    mergeFresh: mergeFresh,
    sitemapThumb: sitemapThumb,
    decodeHtml: decodeHtml,
    cleanText: cleanText,
    cleanTitle: cleanTitle,
    httpUrl: httpUrl,
    httpsUrl: httpsUrl,
    originUrl: originUrl,
    slugFromUrl: slugFromUrl,
    thumbUrl: thumbUrl,
    normalizeIndex: normalizeIndex
  };
}));
