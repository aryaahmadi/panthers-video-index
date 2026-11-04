# panthers-video-index

A searchable index of every video on [panthers.com/video](https://www.panthers.com/video/), rebuilt
hourly from the site's video sitemaps and published as one static JSON file. It is the data source
for the Panthers video search widget (the `search` project) and can be consumed by anything else
that wants a list of Panthers videos with titles, dates, thumbnails, descriptions and tags.
Next to it, the same Action publishes `photos.json`, an index of every photo gallery on
[panthers.com/photos](https://www.panthers.com/photos/) for the photo search (see
[Photo index](#photo-index-photosjson)).

**Live URLs:** `https://aryaahmadi.github.io/panthers-video-index/videos.json` and
`https://aryaahmadi.github.io/panthers-video-index/photos.json`
(GitHub Pages, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=600`, ETag, gzip.)

## Repository layout

| Branch     | Contents                                                                              |
|------------|---------------------------------------------------------------------------------------|
| `main`     | Code: `build-index.py`, `photo-builder/`, the GitHub Action, this README.             |
| `gh-pages` | Data: `videos.json` and `photos.json` only. GitHub Pages serves this branch.          |

The two branches never share files. The Action checks out `main` for the code and `gh-pages`
into `site/` for the data, runs both builders and pushes `site/videos.json` and `site/photos.json`
back to `gh-pages` only when their content changed.

## Index format v2 (`videos.json`)

```json
{
  "version": 2,
  "generated": "2026-09-17T01:40:00Z",
  "base": { "url": "https://www.panthers.com/video/", "thumb": "https://static.clubs.nfl.com/image/" },
  "count": 14921,
  "videos": [
    {
      "slug": "locker-room-sound-week-2-vs-atlanta-falcons",
      "title": "Locker Room Sound | Week 2 vs. Atlanta Falcons",
      "date": "2026-09-16",
      "thumb": "upload/zdlbllshodedgsuzlibv",
      "desc": "Watch Panthers WR Tetairoa McMillan, S Nick Scott, ...",
      "tags": ["John Metchie III", "Jaelan Phillips", "Locker Room Sound", "Press Conferences"],
      "dur": 312
    }
  ]
}
```

* `videos` is sorted by `date` descending. Among videos with the same date, the ones already in
  the index keep their previous order and new ones go first, in sitemap order (newest sitemap
  first). panthers.com lists same-date videos in a different order each time it regenerates the
  sitemaps, and following it would rewrite the file on runs that found nothing new. A
  `--from-scratch` build uses sitemap order.
* `slug` - the path after `/video/`. Full page URL = `base.url + slug`.
* `date` - `YYYY-MM-DD` publication date.
* `thumb` - `"upload/<id>"` or `"private/<id>"`: the Cloudinary delivery type and public id of the
  thumbnail on `static.clubs.nfl.com` (extension and `/v123/` version segment stripped). Build an
  image URL as `base.thumb + type + "/" + TRANSFORM + "/panthers/" + id + ".jpg"`, e.g.
  `https://static.clubs.nfl.com/image/upload/w_480,h_270,c_fill,g_auto,q_auto,f_auto/panthers/<id>.jpg`.
  The delivery type must be preserved (`upload` transforms 404 for `private` assets). If the value
  starts with `http` it is a full URL on some other host - use it as-is. Omitted when unknown.
* `desc` - description, entities decoded, HTML tags removed, whitespace collapsed, at most 400
  characters. Omitted when empty.
* `tags` - cleaned CMS tags (players, series such as `Press Conferences`, `Highlights`,
  `Panthers Huddle`, `TopCats`, `Wired`, game references such as
  `Carolina Panthers at Atlanta Falcons (2026-REG-2)`). CMS noise (`migrated`, `Team`,
  `Featured Video`, `Latest Video`, `App Video`, `videochannel/...`, slug-like junk) is removed.
  Omitted when empty.
* `dur` - duration in whole seconds. Omitted when unknown or 0.

The JSON is written compact (no whitespace, `ensure_ascii=False`) as UTF-8. Version 1 of the file
was a bare array of `{title,url,date,thumb,desc}` objects; consumers should still tolerate it.

## The builder (`build-index.py`)

Python 3.9+; the only third-party dependency is `requests`.

```bash
pip install requests
git clone https://github.com/aryaahmadi/panthers-video-index
cd panthers-video-index                                # on main; the data file lives only on gh-pages
git show origin/gh-pages:videos.json > videos.json     # start from the published index
python3 build-index.py                                 # merges into ./videos.json in place
```

Use `origin/gh-pages`, not `gh-pages`: a fresh clone has the remote-tracking branch but no local
`gh-pages` branch, so `git show gh-pages:videos.json` fails there. In an older clone run
`git fetch origin` first so `origin/gh-pages` is current.

The builder **refuses to run when the `--existing` file is missing** (exit code 2). Every video that
has dropped out of the sitemaps survives only through the merge, so starting over silently would
lose them. If you really want a sitemap-only index, say so:

```bash
python3 build-index.py --from-scratch --out videos.json   # no merge; drops sitemap-absent videos
```

For repeated local runs, download the sitemaps once and read them from disk instead of fetching
~10 MB every time (`sitemap-video-*.xml` is git-ignored):

```bash
for f in fast-changing archive_1 archive_2 archive_3; do curl -sSO https://www.panthers.com/sitemap-video-$f.xml; done
python3 build-index.py --sitemaps-dir . --no-verify --out videos.test.json   # ~1 s, no network
```

To publish a manual build, copy the result onto the `gh-pages` branch (the file is untracked on
`main`, so move it aside before switching):

```bash
mv videos.json videos.new.json
git checkout gh-pages                                  # a fresh clone creates it from origin/gh-pages
mv videos.new.json videos.json
git add videos.json && git commit -m "Update video index (manual $(date -u +%Y-%m-%d))" && git push origin gh-pages
git checkout main
```

Options:

| Option                | Default       | Meaning |
|-----------------------|---------------|---------|
| `--existing PATH`     | `videos.json` | Index to merge into (v1 or v2). Must exist: a missing file is an error (exit 2) unless `--from-scratch` is given. |
| `--out PATH`          | `videos.json` | Where to write the result (written atomically). |
| `--no-verify`         | off           | Keep entries that are missing from the sitemaps without checking them online. |
| `--sitemaps-dir DIR`  | fetch live    | Read `sitemap-video-fast-changing.xml` and `sitemap-video-archive_N.xml` from a local directory (fast iteration / offline). |
| `--from-scratch`      | off           | Build from the sitemaps alone and ignore `--existing`. Drops every video that is no longer in a sitemap - only for deliberately starting a new index. |
| `--max-drop N`        | `50`          | Safety valve: refuse to write if more than N existing entries would be dropped. |
| `--workers N`         | `20`          | Concurrent HEAD/GET checks. |

What it does:

1. Reads `https://www.panthers.com/sitemap-index.xml` to discover the video sitemaps (the four
   known ones - `sitemap-video-fast-changing.xml`, `sitemap-video-archive_1..3.xml` - are required;
   any further `sitemap-video-*` entries are picked up automatically). Responses are decoded as
   UTF-8 from the raw bytes (the `requests` text decoder mis-guesses Latin-1 and produces mojibake).
   A failed required sitemap aborts the run rather than producing an index with thousands of
   videos missing.
2. Parses every `<url>` block as a unit (title, description, thumbnail, date, duration and tags
   are taken from the same block - the previous scraper matched them positionally and misaligned
   ~96% of descriptions). Entities are decoded, HTML markup the CMS leaves in descriptions
   (`3<sup>rd</sup>`, `<a href=...>`) stripped, NBSP and other odd whitespace collapsed, category
   listing slugs (`/video/highlights`, `/video/wired`, ...) skipped, thumbnails normalised to
   `upload/<id>` | `private/<id>`, tags cleaned and de-duplicated.
3. Merges with the existing index. Sitemap data wins for videos present in both. Videos that are
   in the existing index but in no sitemap (the sitemaps have a coverage gap between the archive
   and the "last 100" feed, and some old videos have been dropped from them while their pages
   still exist) are checked with a HEAD (falling back to GET, 10 s timeout, 20 threads) and kept
   unless the page answers 404 / 410 or redirects to the `/video/` listing page, which is how
   panthers.com answers unknown slugs. Network errors keep the entry.
4. Migrates a v1 index on the fly: URL -> slug, thumbnail URL -> `upload/<id>`, `dateVerified`
   dropped. Because v1 descriptions/thumbnails were corrupt, v1-only entries get their `og:image`
   and `og:description` re-read from the video page (parsed with `html.parser`, so a description
   containing an apostrophe is not cut short); if that fails they keep title, slug, date and the
   old thumbnail with no description.
5. Sorts, writes compact JSON and prints per-sitemap counts, new / updated / kept / dropped
   counts, the total and the raw + gzip size. Output is deterministic - if nothing changed the file
   is byte-identical (the `generated` timestamp is only bumped when the video list changed, and
   same-date videos keep their order, see above), so the hourly Action only commits real changes.

## Photo index (`photos.json`)

```json
{
  "version": 1,
  "generated": "2026-11-04T14:36:02Z",
  "base": { "url": "https://www.panthers.com/photos/", "thumb": "https://static.clubs.nfl.com/image/" },
  "count": 3756,
  "galleries": [
    {
      "slug": "panthers-practice-week-9-vs-broncos-november-3-2026",
      "title": "Panthers practice | Week 9 vs. Broncos | November 3, 2026",
      "date": "2026-11-03",
      "thumb": "upload/crwai89cyhsrnaj5ugyp",
      "desc": "View photos from Tuesday's practice as the Panthers prepare to take on the Denver Broncos in Week 9.",
      "tags": ["Denver Broncos at Carolina Panthers (2026-REG-9)"],
      "people": ["Tetairoa McMillan", "Ja'seem Reed", "Jalen Coker", "Nick Scott"],
      "n": 36
    }
  ]
}
```

* `galleries` is sorted by `date` descending. Among galleries with the same date, the ones already
  in the index keep their previous order and new ones go first, in feed order (the feed lists
  same-date galleries in a different order from one request to the next, and following it would
  rewrite the file on runs that found nothing new). A first `--bootstrap` build uses the feed's order.
* `slug`, `date`, `thumb` - as in `videos.json`: page URL = `base.url + slug`; `thumb` is
  `upload/<id>` or `private/<id>` on `static.clubs.nfl.com` (most galleries are `private`), and the
  delivery type must be kept when building the image URL.
* `title` - the gallery title, with a leading "PHOTOS:" dropped.
* `desc` - the feed card's summary, or the gallery page's description when the card has none
  (never the site's default "The official website of the Carolina Panthers..." text). Omitted when empty.
* `tags` - the page's JSON-LD keywords minus CMS noise. Omitted when empty.
* `people` - names found in the photo captions, most mentioned first, at most 40. Omitted when
  none: most galleries since ~2016 have camera file names ("AH102849") instead of captions, so only
  about a fifth of the galleries have any.
* `n` - number of photos.

**Where it comes from.** panthers.com publishes no photo sitemap. The builder walks the site's
internal gallery feed (`/api/lazy/load`, the backend of the "Load More" button on
/photos/archives, 100 galleries per page - asking for more silently returns 25), reads the 7
/photos listing pages for the few galleries the feed misses, and reads each gallery page once for
its tags, photo count and captions. An hourly run costs ~45 requests plus one page per new gallery.

**The builder** is `photo-builder/` (Node 18+, no dependencies). Its three files are copied
unchanged from the `search` project, where they have tests and where the widget runs the same
parsing code on the live feed: `tools/build-photo-index.js`, `src/photo-index.js` and
`src/index-normalize.js` (the widget's video-index normaliser, which the parser reuses). Change
them there, run its tests, and copy them over (from this repo's root, with the `search` project
cloned next to it); the `cmp` loop prints nothing when the copies are in sync:

```bash
cp ../search/tools/build-photo-index.js photo-builder/tools/
cp ../search/src/photo-index.js ../search/src/index-normalize.js photo-builder/src/
for f in tools/build-photo-index.js src/photo-index.js src/index-normalize.js; do cmp ../search/$f photo-builder/$f; done
```

To run it by hand:

```bash
git show origin/gh-pages:photos.json > photos.json     # start from the published index
node photo-builder/tools/build-photo-index.js --out photos.json
```

* A missing `--out` file is an error unless `--bootstrap` is given (a first build reads all ~3,750
  gallery pages, about 1.7 GB), so a misconfigured job cannot quietly re-crawl the whole site.
* It refuses to write when the feed returned less than half of the galleries the index holds
  (the feed is undocumented and could change); `--force` writes anyway.
* Galleries that drop out of the feed are kept. A gallery page that fails keeps what the index
  knew (a new gallery is written without tags/people and read again next run); exit code 2 reports it.
* A run that changes nothing leaves the file byte-identical (same `generated`).
* `--limit N`, `--cache DIR`, `--reparse`, `--refetch`, `--concurrency N`: see the comment at the
  top of `photo-builder/tools/build-photo-index.js`.

## Automation

`.github/workflows/update-index.yml` ("Update video and photo index") runs hourly (at :17 past the
hour) and on manual dispatch (Actions tab -> "Update video and photo index" -> "Run workflow"). It
installs `requests` and Node 24, runs
`python3 build-index.py --existing site/videos.json --out site/videos.json` and
`node photo-builder/tools/build-photo-index.js --out site/photos.json`, and commits + pushes the
files that changed to `gh-pages` with the built-in `GITHUB_TOKEN` (`permissions: contents: write`)
only when `git diff` reports a change. GitHub Pages redeploys on push; the CDN cache is 10 minutes.

The two builds are independent. If one fails, its file is put back as published (so a half-written
file is never pushed), the other is still published, and the run fails at its last step so the
failure is visible. The photo build's exit code 2 (some gallery pages could not be read; they are
retried next run) is a warning, not a failure. The photo builder is stopped after 14 minutes (the
step itself after 15); a timed-out build counts as failed.

Two things bound freshness: GitHub can start scheduled jobs late (runs meant for 11:00 UTC started
3-4 hours late in September 2026), and the site's fast-changing sitemap itself can lag a new video by
hours. So the widget does not rely on this index alone: on panthers.com it also reads
`/sitemap-video-fast-changing.xml` (same origin) at page load and merges the newest ~100 videos in,
with the same parsing rules as `build-index.py`. A new video is searchable as soon as the site lists it.

## Consumer

The widget in the `search` project fetches the live URL once per page load (no cache-buster, so
HTTP caching works), normalises v1/v2 to one shape and searches client-side. Its photo build
(`embed-photos.html`) does the same with `photos.json`, and on panthers.com also merges the first
page of the gallery feed, so a new gallery is searchable by title before the next index build.
