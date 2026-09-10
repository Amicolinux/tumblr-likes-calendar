# Tumblr Likes Calendar

Firefox extension that adds a **heatmap calendar** of your "likes" to the Tumblr
Likes page (`tumblr.com/likes`): each day is shaded based on how many posts you
liked, and clicking a day jumps you straight to the likes from that date.

Tumblr's likes can't be searched or filtered, so finding an image you saved
months ago means scrolling endlessly. This extension turns your likes into
something you can actually navigate by date.

📦 **Available on Firefox Add-ons:**
https://addons.mozilla.org/firefox/addon/tumblr-likes-calendar/

## Features

- Heatmap calendar of your likes, one panel per year.
- Click a day → opens `tumblr.com/likes?before=<timestamp>`, i.e. the likes
  from that date.
- Per-day like count on hover.
- Fast: your data is cached locally after the first scan.

## Privacy

Everything stays **on your computer**. The extension reads your likes through
Tumblr's own in-page helper (`window.tumblr.apiFetch`, no API key needed) and
stores only a local summary in your browser. **No data is ever sent anywhere.**

## How it works

The content script runs in the page's main world so it can use
`window.tumblr.apiFetch`, the authenticated helper Tumblr exposes to extensions.
It pages through your likes via the API, reads each like's timestamp
(`likedTimestamp`), and groups them by day. A small aggregate (day → count) is
kept in `localStorage`, so subsequent openings are instant.

## Installation (from source, for testing)

1. Open Firefox at `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `manifest.json` file from this repository.
4. Go to `https://www.tumblr.com/likes`: a **📅 Calendario like** button appears
   at the bottom-right. Click it, then press **Aggiorna** on first run.

## Notes and limitations

- The first scan can take a while if you have many likes.
- The day-jump uses the `?before=` URL parameter; if a future Tumblr interface
  ignores it, that part will need adjusting.
- The calendar shows **when you liked** a post, not when it was published.
- The number of retrievable likes may be slightly lower than Tumblr's counter:
  likes on deleted posts or blogs are no longer returned by the API (and are no
  longer reachable anyway).

## Requirements

Firefox 128 or later.

## Contributing

Bug reports and suggestions are welcome via Issues. For changes, feel free to
open a Pull Request.

## License

Released under the **GNU General Public License v3.0** (GPLv3). See the
[`LICENSE`](LICENSE) file. Anyone distributing modified versions must keep them
open source under the same license.
