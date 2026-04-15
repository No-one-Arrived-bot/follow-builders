#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Fetches tweets via Nitter RSS — no API keys or cookies needed.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------
// Nitter public instances — will try each in order if one fails
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
];

const TWEET_LOOKBACK_HOURS = 48; // 48h buffer in case Nitter is slow
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------
async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {} };
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenTweets) state.seenTweets = {};
    return state;
  } catch {
    return { seenTweets: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Nitter RSS Fetching -----------------------------------------------------
async function fetchNitterRSS(handle) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetch(`${instance}/${handle}/rss`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedFetcher/1.0)' },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) continue;
      const xml = await res.text();
      if (xml.includes('<item>')) return xml;
    } catch {
      // try next instance
    }
  }
  return null;
}

function parseNitterRSS(xml, handle) {
  const tweets = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    // Title (tweet text)
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch
      ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim()
      : '';

    // Link (tweet URL)
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    // PubDate
    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;

    // Extract tweet ID from URL e.g. https://nitter.net/swyx/status/123#m → 123
    const idMatch = link ? link.match(/\/status\/(\d+)/) : null;
    const id = idMatch ? idMatch[1] : null;

    // Build canonical x.com URL
    const tweetUrl = id ? `https://x.com/${handle}/status/${id}` : null;

    // Skip: no id, no url, replies (title starts with @), retweets (title starts with RT)
    if (!id || !tweetUrl) continue;
    if (title.startsWith('RT by ') || title.startsWith('@')) continue;

    tweets.push({ id, text: title, createdAt: pubDate?.toISOString() || null, url: tweetUrl, pubDate });
  }

  return tweets;
}

async function fetchXContent(xAccounts, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const account of xAccounts) {
    try {
      const xml = await fetchNitterRSS(account.handle);
      if (!xml) {
        console.error(`  [skip] ${account.handle}: all Nitter instances failed`);
        continue;
      }

      const allTweets = parseNitterRSS(xml, account.handle);
      const newTweets = [];

      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue;
        if (t.pubDate && t.pubDate < cutoff) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          text: t.text,
          createdAt: t.createdAt,
          url: t.url,
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length > 0) {
        // Extract bio from RSS channel description
        const bioMatch = xml.match(/<description>([\s\S]*?)<\/description>/);
        const bio = bioMatch
          ? bioMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim()
          : '';

        results.push({
          source: 'x',
          name: account.name,
          handle: account.handle,
          bio,
          tweets: newTweets,
        });
        console.error(`  [ok] ${account.handle}: ${newTweets.length} new tweet(s)`);
      } else {
        console.error(`  [skip] ${account.handle}: no new tweets in window`);
      }
    } catch (err) {
      errors.push(`RSS error for ${account.handle}: ${err.message}`);
      console.error(`  [error] ${account.handle}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------
async function main() {
  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  console.error(`Fetching tweets via Nitter RSS for ${sources.x_accounts.length} accounts...`);
  const xContent = await fetchXContent(sources.x_accounts, state, errors);
  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);

  const xFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors,
  };

  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
  console.error(`Done: ${xContent.length} builders, ${totalTweets} tweets`);

  await saveState(state);

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    errors.forEach(e => console.error(`  - ${e}`));
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
