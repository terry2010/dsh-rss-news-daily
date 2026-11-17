<p align="center">
  <img src="https://raw.githubusercontent.com/terry2010/dsh-rss-news-daily/master/assets/banner.jpg" alt="dsh-rss-news-daily" width="760">
</p>

# dsh-rss-news-daily

**Stay on top of the news you care about — without hopping between websites.**

[中文](./README.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-rss-news-daily)](https://www.npmjs.com/package/dsh-rss-news-daily)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`dsh-rss-news-daily` is a news reading & digesting plugin for dsh. Subscribe to the sites you follow, let the plugin collect updates on a schedule, then browse everything in "All News" — or let AI curate a daily digest and period briefings for you.

It is built for people who want to keep tracking industry news, tech updates, or any topic — without opening a pile of sites every day. Which sources to follow, what to focus on, and when to update are all your call.

## What you can do with it

### Catch the day's essentials fast

The plugin checks your enabled sources on a schedule and organizes what it finds. Open "Daily Digest" for the day's top news with AI summaries; "Period Briefings" give you a quick read on what mattered recently. When there's no time to read everything, the digest alone gives you the day's outline.

### Keep your regular reads in one place

"All News" collects every fetched item. Search titles and content, filter by category, show unread only, sort by time. Click through to the original source to read in full; arrange sources and categories however you like.

### Manage subscriptions freely

Start with the built-in sources, add any site's RSS/Atom feed, or import an OPML subscription file. Sources can be enabled, paused, edited, or removed — and built-in sources can be restored. Export OPML to take your list to other readers.

### Tune recommendations to your taste

Mark items as liked or not interested; the plugin uses that feedback to adjust future picks. You can also set followed categories, fetch times, and when the daily digest is generated — so the schedule fits your reading rhythm.

### Read foreign-language news, watch task progress

Translate news with AI when needed. Fetching and translation show live progress, and running tasks can be cancelled. When a source is temporarily unreachable, check its status and retry on demand.

## Usage

1. Install the plugin and open its standalone news panel.
2. Pick categories of interest and enable the sources you want; you can also add RSS/Atom feed links or import an OPML file.
3. Optionally set automatic fetch and digest times — defaults work out of the box.
4. Skim highlights in "Daily Digest"; search and read in "All News".

Before using AI digesting, summarization, or translation, make sure dsh has a working AI model configured. News content comes from the subscribed sources; whether full text is available depends on the original site.

## Data & privacy

- The plugin uses a standalone reading panel — news is never pushed into your chat conversations.
- News items, subscriptions, and reading preferences are stored locally on your machine.
- When AI is used for scoring, summarizing, or translating, the relevant content is sent to the model service you configured in dsh; how it's handled depends on that provider.

## Install

Search for `dsh-rss-news-daily` in dsh's plugin manager. Or use the CLI — install into the profile matching your runtime:

```bash
# Desktop
dsh plugin --profile desktop add dsh-rss-news-daily

# Web / browser
dsh plugin --profile web add dsh-rss-news-daily

# Other runtimes: replace with your profile name
dsh plugin --profile <profile-name> add dsh-rss-news-daily
```

The plugin installs per profile — install once in each runtime you use.

## Feedback & project

This project is actively maintained. Found a bug, inaccurate content, or want a feature? Open an issue or start a discussion on GitHub.

**[github.com/terry2010/dsh-rss-news-daily](https://github.com/terry2010/dsh-rss-news-daily)**

## Related plugins

- **[dsh-rss-news-flash-kuaixun](https://github.com/terry2010/dsh-rss-news-flash-kuaixun)** — real-time finance flash-news companion: six sources at 60-second polling, multi-source corroboration, AI briefings and desktop notifications
- **[dsh-rss-news-browser-fetch](https://github.com/terry2010/dsh-rss-news-browser-fetch)** — browserFetch transport service: dedicated Chrome + CDP, real-fingerprint same-origin fetch fallback for source adapters

## License

Released under the [MIT License](LICENSE).
