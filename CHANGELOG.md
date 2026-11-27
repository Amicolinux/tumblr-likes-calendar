# Changelog

All notable changes to Tumblr Likes Calendar.

## 0.4.1 — 2026-11-26

- The gallery is now virtualized: it can show all your liked images, not just
  the 400 most recent, while keeping the page light. Only the rows visible on
  screen are drawn and recycled as you scroll.
- Filter the gallery in place by tag or by `blog:name`; click an image's blog
  caption to filter to that blog.
- A year/month rail on the right of the gallery jumps straight to any period.
- The gallery and tag suggestions open much faster with many likes.
- Clicking a day now lists that day's likes in the panel instead of navigating
  to `tumblr.com/likes?before=…`, which could land on the wrong day.
- Fixed mixed-up results when clicking days, blogs, tags or gallery filters
  quickly one after another.
- Safer links: suspicious post or image addresses are never turned into
  clickable links.
- Clicking a tag on a result now always searches that exact tag.
- Typing just `blog:` now tells you to add a blog name.
- The Heatmap/Gallery buttons always show which view is active.

## 0.4.0 — never published

Development version, folded into 0.4.1.

- Gallery view of your likes: a "Gallery" toggle on the Calendar tab shows your
  liked image posts as a thumbnail grid, newest first.
- Search your likes by blog: type `blog:name` in the search box, or click a blog
  name in any result.

## 0.3.0 — 2026-11-10

- New "Followed blogs" tab: indexes the original image posts of the blogs you
  follow and lets you search them by tag, shown as a thumbnail grid.
- The download is manual, selectable (all blogs or a chosen subset),
  incremental and resumable: it remembers where it stopped for each blog.

## 0.2.0 — 2026-10-22

- Storage moved from localStorage to IndexedDB: each liked post keeps its tags,
  image URLs, blog, permalink and summary, not just a per-day count.
- Tag search: type a tag (or click one of your most-used tags) to list every
  like carrying it, newest first, each linking back to the post.
- Upgrading from 0.1.x needs a one-time full Refresh to populate tags.

## 0.1.2 — 2026-09-30

- User interface translated to English.

## 0.1.1 — 2026-09-30

- Fixed: clicking a day now jumps to the correct date.
- Firefox manifest declares that no data is collected.

## 0.1.0 — 2026-09-10

- First release: heatmap calendar of your Tumblr likes, one panel per year,
  with per-day counts on hover; clicking a day opens the likes from that date.
