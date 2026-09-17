#!/usr/bin/env python3
"""
build-index.py - build / refresh the Panthers video search index (videos.json, format v2).

Sources: the four (or more) panthers.com video sitemaps. Every <url> block is parsed as one
unit, so a title, description, thumbnail, date and tags always belong to the same video.

Usage:
    python3 build-index.py [--existing videos.json] [--out videos.json] [--no-verify]
                           [--sitemaps-dir DIR] [--from-scratch] [--max-drop N] [--workers N]

Merge rules (see README.md):
  * sitemap data wins for every video that is in a sitemap;
  * videos in the existing index but absent from the sitemaps are KEPT unless a HEAD/GET check
    says the page is gone (404 / 410, or a redirect to the /video/ listing page, which is how
    panthers.com answers unknown slugs). Because of this, a missing --existing file is an error
    (exit 2) unless --from-scratch is given: silently starting over would drop those videos;
  * an existing v1 index (bare array of {title,url,date,thumb,desc}) is migrated to v2; v1-only
    entries have their thumbnail + description re-read from the video page's og: tags because the
    v1 desc/thumb fields were misaligned.

Python 3.9+, stdlib + requests.
"""
from __future__ import annotations

import argparse
import glob
import gzip
import html
import json
from html.parser import HTMLParser
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import requests
from requests.adapters import HTTPAdapter

try:  # urllib3 ships with requests; keep going without retries if the import shape changes
    from urllib3.util.retry import Retry
except Exception:  # pragma: no cover
    Retry = None  # type: ignore

# --------------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------------

SITE = "https://www.panthers.com"
SITEMAP_INDEX_URL = SITE + "/sitemap-index.xml"
# These four are known to exist; the sitemap index may add more (archive_4 ...) over time.
KNOWN_SITEMAPS = [
    "sitemap-video-fast-changing.xml",
    "sitemap-video-archive_1.xml",
    "sitemap-video-archive_2.xml",
    "sitemap-video-archive_3.xml",
]
BASE_URL = "https://www.panthers.com/video/"
BASE_THUMB = "https://static.clubs.nfl.com/image/"
USER_AGENT = (
    "Mozilla/5.0 (compatible; panthers-video-index-builder/2.0; "
    "+https://github.com/aryaahmadi/panthers-video-index)"
)
FETCH_TIMEOUT = 90  # sitemaps
CHECK_TIMEOUT = 10  # per-video HEAD/GET
MAX_DESC = 400

# Listing / category pages that live under /video/ but are not videos.
CATEGORY_SLUGS = {
    "highlights", "blueprint", "interviews", "nfln", "archives", "panthers-fans",
    "panthers-huddle", "panthers-postgame", "social-video", "the-avenue", "lifestyle", "wired",
    "cart-talk", "mailbag", "gameday", "2021-confidential", "topcats", "all",
}

# CMS noise tags (compared lower-cased).
NOISE_TAGS = {
    "migrated", "team", "featured video", "latest video", "app video",
    "draft-tracker-card", "nfl-draft-card", "fr-hide", "fr-live",
}
NOISE_TAG_PREFIXES = ("videochannel/",)
SLUG_JUNK_TAG_RE = re.compile(r"^[a-z0-9]+$")  # dropped when longer than 10 chars
GAME_ID_TAG_RE = re.compile(r"^\d{4}-\d{6,}$")  # e.g. 2016-2016091800

URL_BLOCK_RE = re.compile(r"<url\b[^>]*>(.*?)</url>", re.S)
CDATA_RE = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S)
WS_RE = re.compile(r"[\s  -​  　]+")
SLUG_RE = re.compile(r"^https?://(?:www\.)?panthers\.com/video/([^?#]*?)/*(?:[?#].*)?$", re.I)
THUMB_RE = re.compile(
    r"^https?://static\.clubs\.nfl\.com/image/(upload|private)/"
    r"(?:[^?#]*?/)?panthers/([^/?#]+?)(?:\.(?:jpe?g|png|gif|webp|avif))?(?:[?#].*)?$",
    re.I,
)
LISTING_ROOT_RE = re.compile(r"^(?:https?://(?:www\.)?panthers\.com)?/video/?(?:[?#].*)?$", re.I)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")
# CMS markup that survives entity decoding: 3<sup>rd</sup>, <a href=...>. Inline tags are removed
# without a space ("3rd", not "3 rd"); every other tag becomes a space so words do not run together.
INLINE_TAG_RE = re.compile(r"</?(?:sup|sub|b|i|em|strong|u|span|small)\b[^>]*>", re.I)
TAG_RE = re.compile(r"</?[A-Za-z][^>]*>")
OG_KEYS = {"og:image": "image", "og:description": "description"}


# --------------------------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------------------------

def collapse(text: Optional[str]) -> str:
    """CDATA-unwrap, XML/HTML-unescape, strip HTML tags, NBSP -> space, collapse whitespace, strip."""
    if not text:
        return ""
    text = CDATA_RE.sub(r"\1", text)
    text = html.unescape(text)
    text = TAG_RE.sub(" ", INLINE_TAG_RE.sub("", text))  # tags only exist after unescaping (&lt;sup&gt; in the XML)
    return WS_RE.sub(" ", text).strip()


def truncate(text: str, limit: int = MAX_DESC) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:.-–—") + "…"


def slug_from_url(url: str) -> str:
    m = SLUG_RE.match((url or "").strip())
    return m.group(1).strip("/") if m else ""


def normalize_thumb(url: str) -> str:
    """'upload/<id>' | 'private/<id>' for static.clubs.nfl.com images, full URL otherwise, '' if empty."""
    url = (url or "").strip()
    if not url:
        return ""
    if not url.lower().startswith("http"):
        # already normalized ("upload/<id>") - keep as long as it looks sane
        return url if re.match(r"^(upload|private)/[^/]+$", url) else ""
    m = THUMB_RE.match(url)
    if m:
        return "%s/%s" % (m.group(1).lower(), m.group(2))
    return url


def clean_tag_list(raw: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for t in raw:
        t = collapse(t)
        if not t:
            continue
        low = t.lower()
        if low in NOISE_TAGS or low.startswith(NOISE_TAG_PREFIXES):
            continue
        if SLUG_JUNK_TAG_RE.match(t) and len(t) > 10:
            continue
        if GAME_ID_TAG_RE.match(t):
            continue
        if low in seen:
            continue
        seen.add(low)
        out.append(t)
    return out


def clean_tags(raw: str) -> List[str]:
    return clean_tag_list(collapse(raw).split(",")) if raw else []


def parse_duration(raw: str) -> int:
    raw = (raw or "").strip()
    if raw.isdigit():
        return int(raw)
    return 0  # ISO-8601 or garbage ("P1DT26M" occurs once and is bogus) -> omitted


def make_entry(slug: str, title: str, date: str, thumb: str = "", desc: str = "",
               tags: Optional[List[str]] = None, dur: int = 0) -> Dict:
    e: Dict = {"slug": slug, "title": title, "date": date}
    if thumb:
        e["thumb"] = thumb
    if desc:
        e["desc"] = desc
    if tags:
        e["tags"] = tags
    if dur and dur > 0:
        e["dur"] = int(dur)
    return e


# --------------------------------------------------------------------------------------------
# Sitemap parsing
# --------------------------------------------------------------------------------------------

def xml_field(block: str, name: str) -> str:
    m = re.search(r"<%s(?:\s[^>]*)?>(.*?)</%s>" % (re.escape(name), re.escape(name)), block, re.S)
    return collapse(m.group(1)) if m else ""


def parse_sitemap(xml_text: str) -> List[Dict]:
    """One entry per <url> block. Category slugs and blocks without a usable slug are skipped."""
    entries: List[Dict] = []
    for block in URL_BLOCK_RE.findall(xml_text):
        slug = slug_from_url(xml_field(block, "loc"))
        if not slug or slug in CATEGORY_SLUGS:
            continue
        title = xml_field(block, "video:title")
        if not title:
            title = slug.replace("-", " ").strip().capitalize()
        pub = xml_field(block, "video:publication_date")
        if not DATE_RE.match(pub):
            pub = xml_field(block, "lastmod")
        date = pub[:10] if DATE_RE.match(pub) else ""
        entries.append(make_entry(
            slug=slug,
            title=title,
            date=date,
            thumb=normalize_thumb(xml_field(block, "video:thumbnail_loc")),
            desc=truncate(xml_field(block, "video:description")),
            tags=clean_tags(xml_field(block, "video:tag")),
            dur=parse_duration(xml_field(block, "video:duration")),
        ))
    return entries


def count_blocks(xml_text: str) -> int:
    return len(URL_BLOCK_RE.findall(xml_text))


# --------------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------------

def make_session(workers: int) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
    })
    kwargs = {"pool_connections": workers, "pool_maxsize": workers}
    if Retry is not None:
        kwargs["max_retries"] = Retry(total=2, backoff_factor=1.0,
                                      status_forcelist=(500, 502, 503, 504),
                                      allowed_methods=frozenset(["HEAD", "GET"]))
    adapter = HTTPAdapter(**kwargs)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def discover_sitemap_names(session: requests.Session) -> List[str]:
    """Known four first (required), then any extra video sitemaps listed in sitemap-index.xml."""
    names = list(KNOWN_SITEMAPS)
    try:
        r = session.get(SITEMAP_INDEX_URL, timeout=FETCH_TIMEOUT)
        r.raise_for_status()
        text = r.content.decode("utf-8", "replace")
        for loc in re.findall(r"<loc>\s*([^<]+?)\s*</loc>", text):
            name = loc.rsplit("/", 1)[-1]
            if name.startswith("sitemap-video-") and name not in names:
                names.append(name)
    except Exception as ex:  # discovery is best-effort; the known four are enough
        print("warn: could not read %s (%s); using the known sitemap list" % (SITEMAP_INDEX_URL, ex))
    return names


def fetch_sitemap(session: requests.Session, name: str, required: bool) -> Optional[str]:
    url = "%s/%s" % (SITE, name)
    last_err: Optional[str] = None
    for attempt in range(1, 4):
        try:
            r = session.get(url, timeout=FETCH_TIMEOUT)
            if r.status_code == 200:
                text = r.content.decode("utf-8", "replace")  # never trust r.text (mis-detects Latin-1)
                if "<urlset" in text:
                    return text
                last_err = "no <urlset> in response"
            elif r.status_code in (204, 404, 410) and not required:
                return None  # optional extra archive that does not exist
            else:
                last_err = "HTTP %s" % r.status_code
        except Exception as ex:
            last_err = str(ex)
        time.sleep(2 * attempt)
    if required:
        sys.exit("error: could not fetch required sitemap %s (%s); refusing to build from an "
                 "incomplete sitemap set" % (url, last_err))
    print("warn: skipping optional sitemap %s (%s)" % (name, last_err))
    return None


def load_sitemaps(session: Optional[requests.Session], sitemaps_dir: Optional[str]) -> List[Tuple[str, str]]:
    """Returns [(name, xml_text)] in sitemap order: fast-changing first, then archive_1..N."""
    out: List[Tuple[str, str]] = []
    if sitemaps_dir:
        fast = os.path.join(sitemaps_dir, "sitemap-video-fast-changing.xml")
        archives = glob.glob(os.path.join(sitemaps_dir, "sitemap-video-archive_*.xml"))

        def archive_no(p: str) -> int:
            m = re.search(r"_(\d+)\.xml$", p)
            return int(m.group(1)) if m else 0

        archives.sort(key=archive_no)
        if not os.path.exists(fast) or not archives:
            sys.exit("error: %s must contain sitemap-video-fast-changing.xml and sitemap-video-archive_N.xml" % sitemaps_dir)
        for path in [fast] + archives:
            with open(path, "rb") as fh:
                out.append((os.path.basename(path), fh.read().decode("utf-8", "replace")))
        return out
    assert session is not None
    for name in discover_sitemap_names(session):
        text = fetch_sitemap(session, name, required=name in KNOWN_SITEMAPS)
        if text is not None:
            out.append((name, text))
    return out


# --- per-video checks -----------------------------------------------------------------------

def classify(r: requests.Response) -> str:
    """'gone' for 404/410 or a redirect to the /video/ listing root (soft-404); 'ok' otherwise."""
    if r.status_code in (404, 410):
        return "gone"
    if 300 <= r.status_code < 400 and LISTING_ROOT_RE.match(r.headers.get("Location", "")):
        return "gone"
    return "ok"


def check_alive(session: requests.Session, url: str) -> str:
    """HEAD, falling back to GET. Returns 'ok' | 'gone' | 'error' (error -> keep the entry)."""
    try:
        r = session.head(url, timeout=CHECK_TIMEOUT, allow_redirects=False)
        if r.status_code not in (405, 403, 429) and r.status_code < 500:
            return classify(r)
    except Exception:
        pass
    try:
        r = session.get(url, timeout=CHECK_TIMEOUT, allow_redirects=False, stream=True)
        try:
            return classify(r)
        finally:
            r.close()
    except Exception:
        return "error"


class OgMetaParser(HTMLParser):
    """Collects og:image / og:description from <meta> tags (first occurrence wins).

    A real HTML parser instead of a regex: a double-quoted content attribute that contains an
    apostrophe ("... after Wednesday's practice ...") is read up to its closing double quote,
    where a [\"']([^\"']*)[\"'] regex stopped at the apostrophe. Entities are decoded by the parser.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.og: Dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs) -> None:  # HTMLParser also routes <meta ... /> here
        if tag != "meta":
            return
        a = {(k or "").lower(): (v or "") for k, v in attrs}
        for name_attr in ("property", "name"):
            key = OG_KEYS.get(a.get(name_attr, "").strip().lower())
            if key:
                self.og.setdefault(key, a.get("content", ""))
                return


def parse_og(page: str) -> Dict[str, str]:
    p = OgMetaParser()
    try:
        p.feed(page)
        p.close()
    except Exception:  # malformed markup: keep whatever was collected before the error
        pass
    return p.og


def hydrate(session: requests.Session, url: str) -> Tuple[str, str, str]:
    """GET the video page; returns (status, og_image, og_description). status: ok | gone | error."""
    try:
        r = session.get(url, timeout=CHECK_TIMEOUT, allow_redirects=True)
    except Exception:
        return "error", "", ""
    if r.status_code in (404, 410) or LISTING_ROOT_RE.match(r.url or ""):
        return "gone", "", ""
    for hop in r.history:
        if LISTING_ROOT_RE.match(hop.headers.get("Location", "")):
            return "gone", "", ""
    if r.status_code >= 400:
        return "error", "", ""
    og = parse_og(r.content.decode("utf-8", "replace"))
    return "ok", og.get("image", "").strip(), og.get("description", "")


# --------------------------------------------------------------------------------------------
# Existing index
# --------------------------------------------------------------------------------------------

def load_existing(path: Optional[str]) -> Tuple[List[Tuple[Dict, bool]], Optional[Dict]]:
    """Returns ([(entry_v2, is_v1)], meta). meta is the v2 wrapper (without videos) or None."""
    if not path or not os.path.exists(path):
        return [], None
    with open(path, "rb") as fh:
        data = json.loads(fh.read().decode("utf-8"))
    if isinstance(data, list):
        raw, is_v1, meta = data, True, None
    elif isinstance(data, dict) and isinstance(data.get("videos"), list):
        raw, is_v1 = data["videos"], False
        meta = {k: v for k, v in data.items() if k != "videos"}
    else:
        sys.exit("error: %s is neither a v1 array nor a v2 object" % path)
    out: List[Tuple[Dict, bool]] = []
    for v in raw:
        if not isinstance(v, dict):
            continue
        slug = collapse(v.get("slug", "")) or slug_from_url(v.get("url", ""))
        if not slug or slug in CATEGORY_SLUGS:
            continue
        title = collapse(v.get("title", "")) or slug.replace("-", " ").capitalize()
        date = collapse(v.get("date", ""))[:10]
        if not DATE_RE.match(date):
            date = ""
        thumb = normalize_thumb(v.get("thumb", "") or "")
        if is_v1:
            # v1 desc is misaligned with the title in ~96% of entries -> blank; refilled by hydrate()
            entry = make_entry(slug, title, date, thumb=thumb)
        else:
            tags = v.get("tags") or []
            entry = make_entry(slug, title, date, thumb=thumb,
                               desc=truncate(collapse(v.get("desc", ""))),
                               tags=clean_tag_list([str(t) for t in tags]),
                               dur=parse_duration(str(v.get("dur", 0) or 0)))
        out.append((entry, is_v1))
    return out, meta


# --------------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------------

def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Build / refresh the Panthers video index (format v2).")
    ap.add_argument("--existing", default="videos.json",
                    help="existing index to merge into (v1 or v2); default videos.json. Must exist unless --from-scratch is given")
    ap.add_argument("--out", default="videos.json", help="output path; default videos.json")
    ap.add_argument("--no-verify", action="store_true",
                    help="keep entries missing from the sitemaps without checking them (no HEAD/GET, no og: hydration)")
    ap.add_argument("--sitemaps-dir", default=None,
                    help="read sitemap-video-*.xml from this directory instead of fetching them")
    ap.add_argument("--from-scratch", action="store_true",
                    help="build from the sitemaps alone, ignoring --existing. Without this flag a missing --existing "
                         "file is an error (exit 2), because building without it would silently drop every video "
                         "that is no longer in the sitemaps")
    ap.add_argument("--max-drop", type=int, default=50,
                    help="refuse to write if more than N existing entries would be dropped (default 50)")
    ap.add_argument("--workers", type=int, default=20, help="concurrent HEAD/GET checks (default 20)")
    args = ap.parse_args(argv)

    if args.from_scratch:
        args.existing = None
    elif not args.existing or not os.path.isfile(args.existing):
        print("error: existing index %r not found. Building without it would drop every video that is no "
              "longer in the sitemaps (merging into the published index is the whole point of this script).\n"
              "  Put the published file there first:  git show origin/gh-pages:videos.json > videos.json\n"
              "  or pass --from-scratch to build a fresh, sitemap-only index on purpose."
              % args.existing, file=sys.stderr)
        return 2

    t0 = time.time()
    session = make_session(max(1, args.workers))

    # 1. sitemaps -----------------------------------------------------------------------------
    sitemaps = load_sitemaps(None if args.sitemaps_dir else session, args.sitemaps_dir)
    sitemap_entries: List[Dict] = []
    seen = set()
    dups = 0
    blocks_total = 0
    print("Sitemaps:")
    for name, text in sitemaps:
        parsed = parse_sitemap(text)
        blocks = count_blocks(text)
        blocks_total += blocks
        added = 0
        for e in parsed:
            if e["slug"] in seen:
                dups += 1
                continue
            seen.add(e["slug"])
            sitemap_entries.append(e)
            added += 1
        print("  %-36s %5d blocks, %5d videos (%d skipped)" % (name, blocks, added, blocks - added))
    if not sitemap_entries:
        sys.exit("error: no videos parsed from the sitemaps")
    print("  total: %d blocks -> %d videos (%d category/invalid skipped, %d duplicate slugs)"
          % (blocks_total, len(sitemap_entries), blocks_total - len(sitemap_entries) - dups, dups))

    # 2. existing -----------------------------------------------------------------------------
    existing, meta = load_existing(args.existing)
    existing_by_slug: Dict[str, Tuple[Dict, bool]] = {}
    for entry, is_v1 in existing:
        existing_by_slug.setdefault(entry["slug"], (entry, is_v1))
    if existing:
        print("Existing index: %s (%d entries, format v%d)"
              % (args.existing, len(existing_by_slug), 1 if existing[0][1] else 2))
    elif args.from_scratch:
        print("Existing index: none (--from-scratch) - building from the sitemaps alone")
    else:
        print("Existing index: %s has no entries - building from the sitemaps alone" % args.existing)

    new = updated = changed = 0
    for e in sitemap_entries:
        old = existing_by_slug.get(e["slug"])
        if old is None:
            new += 1
        else:
            updated += 1
            if old[1] or dumps(old[0]) != dumps(e):
                changed += 1

    missing = [(entry, is_v1) for slug, (entry, is_v1) in existing_by_slug.items() if slug not in seen]

    # 3. verify / hydrate entries that are no longer in any sitemap ----------------------------
    kept: List[Dict] = []
    dropped: List[str] = []
    hydrated = hydrate_failed = errors = 0
    if missing:
        print("Entries missing from sitemaps: %d (%d v1-only)" % (len(missing), sum(1 for _, v1 in missing if v1)))
    if missing and args.no_verify:
        kept = [entry for entry, _ in missing]
        print("  --no-verify: keeping all of them unchecked")
    elif missing:
        def work(item: Tuple[Dict, bool]) -> Tuple[Dict, str]:
            entry, is_v1 = item
            url = BASE_URL + entry["slug"]
            if is_v1:
                status, og_image, og_desc = hydrate(session, url)
                if status == "ok":
                    entry = dict(entry)
                    thumb = normalize_thumb(og_image) or entry.get("thumb", "")
                    desc = truncate(collapse(og_desc))
                    entry = make_entry(entry["slug"], entry["title"], entry["date"], thumb=thumb, desc=desc)
                    return entry, "hydrated" if (og_image or og_desc) else "ok"
                return entry, status
            return entry, check_alive(session, url)

        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            results = list(pool.map(work, missing))
        for entry, status in results:
            if status == "gone":
                dropped.append(entry["slug"])
            else:
                kept.append(entry)
                if status == "hydrated":
                    hydrated += 1
                elif status == "error":
                    errors += 1
                elif status == "ok" and existing_by_slug[entry["slug"]][1]:
                    hydrate_failed += 1
        print("  verified: kept %d (hydrated %d, og-tags missing %d, network errors %d), dropped %d"
              % (len(kept), hydrated, hydrate_failed, errors, len(dropped)))
        for slug in dropped:
            print("    dropped: %s" % slug)
        if len(dropped) > args.max_drop:
            sys.exit("error: %d entries would be dropped (> --max-drop %d); refusing to write %s"
                     % (len(dropped), args.max_drop, args.out))

    # 4. assemble, sort, write ---------------------------------------------------------------
    # Python's sort is stable even with reverse=True, so ties keep sitemap order (kept entries after).
    videos = sorted(sitemap_entries + kept, key=lambda e: e["date"], reverse=True)
    videos_json = dumps(videos)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if meta and meta.get("version") == 2 and meta.get("generated") and existing:
        # unchanged content -> keep the previous timestamp so the output is byte-identical
        if dumps([e for e, _ in existing]) == videos_json:
            generated = meta["generated"]

    out_text = ('{"version":2,"generated":%s,"base":%s,"count":%d,"videos":%s}\n'
                % (dumps(generated), dumps({"url": BASE_URL, "thumb": BASE_THUMB}), len(videos), videos_json))
    raw = out_text.encode("utf-8")
    tmp = args.out + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(raw)
    os.replace(tmp, args.out)

    gz = len(gzip.compress(raw, compresslevel=6))
    with_tags = sum(1 for v in videos if v.get("tags"))
    with_dur = sum(1 for v in videos if v.get("dur"))
    with_desc = sum(1 for v in videos if v.get("desc"))
    with_thumb = sum(1 for v in videos if v.get("thumb"))
    print("Result:")
    print("  new %d, updated %d (changed %d), kept %d, dropped %d" % (new, updated, changed, len(kept), len(dropped)))
    print("  total %d videos (%d with desc, %d with thumb, %d with tags, %d with dur)"
          % (len(videos), with_desc, with_thumb, with_tags, with_dur))
    print("  newest %s, oldest %s" % (videos[0]["date"] if videos else "-",
                                       next((v["date"] for v in reversed(videos) if v["date"]), "-")))
    print("  wrote %s: %s bytes raw, %s bytes gzip, generated %s"
          % (args.out, format(len(raw), ","), format(gz, ","), generated))
    print("  done in %.1fs" % (time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
