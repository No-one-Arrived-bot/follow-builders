#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator
// ============================================================================
// Uses Apify for Twitter scraping.
// Env vars needed: APIFY_API_TOKEN, TWITTER_COOKIE
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------
const APIFY_RUN_URL = 'https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs';

const TWEET_LOOKBACK_HOURS = 24;
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

// -- X/Twitter Fetching (Apify) ----------------------------------------------

// Extract handle from tweet URL — most reliable regardless of actor field naming
// e.g. https://x.com/swyx/status/123 → "swyx"
function extractHandleFromUrl(tweet) {
  const url = tweet.url || tweet.twitterUrl || tweet.tweetUrl || '';
  const match = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i);
  if (match && match[1] !== 'i') return match[1].toLowerCase();
  return (
    tweet.author?.userName ||
    tweet.author?.username ||
    tweet.author?.screenName ||
    tweet.user?.screen_name ||
    tweet.user?.userName ||
    tweet.screenName ||
    tweet.userName ||
    tweet.username
  )?.toLowerCase() || null;
}

async function fetchXContent(xAccounts, apifyToken, twitterCookie, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const handles = xAccounts.map(a => a.handle);

  try {
    console.error(`  Triggering Apify Twitter Scraper for ${handles.length} handles...`);

    const input = {
      startUrls: handles.map(h => ({ url: `https://x.com/search?q=from%3A${h}&f=live` })),
      maxItems: handles.length * 5,
      addUserInfo: true,
    };
    if (twitterCookie) input.cookie = twitterCookie;

    const runRes = await fetch(`${APIFY_RUN_URL}?token=${apifyToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });

    if (!runRes.ok) throw new Error(`Apify run start failed: HTTP ${runRes.status}`);
    const runData = await runRes.json();
    const runId = runData.data?.id;
    if (!runId) throw new Error(`Apify did not return a run ID: ${JSON.stringify(runData)}`);
    console.error(`  Apify run started: ${runId}`);

    // Poll for completion (max ~5 mins)
    let status = 'RUNNING';
    for (let i = 0; i < 30 && (status === 'RUNNING' || status === 'READY'); i++) {
      await new Promise(r => setTimeout(r, 10000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusData = await statusRes.json();
      status = statusData.data?.status;
      console.error(`    Apify status: ${status} (${i + 1}/30)`);
    }

    if (status !== 'SUCCEEDED') throw new Error(`Apify run ended with status: ${status}`);

    const datasetRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${apifyToken}`
    );
    if (!datasetRes.ok) throw new Error(`Failed to fetch Apify dataset: HTTP ${datasetRes.status}`);
    const data = await datasetRes.json();

    // Filter out placeholder {noResults: true} objects
    const realTweets = data.filter(t => !t.noResults && (t.url || t.twitterUrl || t.tweetUrl || t.id));
    console.error(`  Apify returned ${data.length} items, ${realTweets.length} real tweets`);

    if (realTweets.length > 0) {
      const s = realTweets[0];
      console.error(`  Sample top-level keys: ${Object.keys(s).join(', ')}`);
      console.error(`  Sample url: ${s.url || s.twitterUrl || s.tweetUrl || '(none)'}`);
      console.error(`  Sample handle: ${extractHandleFromUrl(s) || '(failed)'}`);
    }

    // Group by handle extracted from tweet URL
    const tweetsByHandle = {};
    for (const t of realTweets) {
      const handle = extractHandleFromUrl(t);
      if (!handle) continue;
      if (!tweetsByHandle[handle]) tweetsByHandle[handle] = [];
      tweetsByHandle[handle].push(t);
    }
    console.error(`  Handles found: ${Object.keys(tweetsByHandle).join(', ') || 'none'}`);

    // Build output per account
    for (const account of xAccounts) {
      const handleLower = account.handle.toLowerCase();
      const allTweets = tweetsByHandle[handleLower] || [];
      const newTweets = [];

      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue;
        if (new Date(t.createdAt) < cutoff) continue;
        if (t.isRetweet || t.isReply) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          text: t.fullText || t.text,
          createdAt: t.createdAt,
          url: t.url || t.twitterUrl || t.tweetUrl,
          likes: t.likeCount || t.favoriteCount || 0,
          retweets: t.retweetCount || 0,
          replies: t.replyCount || 0,
          isQuote: t.isQuote || false,
        });
        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length > 0) {
        results.push({
          source: 'x',
          name: account.name,
          handle: account.handle,
          bio: allTweets[0]?.author?.description || allTweets[0]?.author?.bio || '',
          tweets: newTweets
        });
      }
    }
  } catch (err) {
    errors.push(`Apify Twitter fetch error: ${err.message}`);
    console.error(`  Apify error: ${err.message}`);
  }

  return results;
}

// -- Main --------------------------------------------------------------------
async function main() {
  const apifyToken = process.env.APIFY_API_TOKEN;
  const twitterCookie = process.env.TWITTER_COOKIE || '';

  if (!apifyToken) { console.error('APIFY_API_TOKEN not set'); process.exit(1); }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  console.error('Fetching X/Twitter content via Apify...');
  const xContent = await fetchXContent(sources.x_accounts, apifyToken, twitterCookie, state, errors);
  const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);

  const xFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { xBuilders: xContent.length, totalTweets },
    errors: errors.filter(e => e.startsWith('Apify'))
  };
  await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
  console.error(`  feed-x.json: ${xContent.length} builders, ${totalTweets} tweets`);

  await saveState(state);

  if (errors.length > 0) {
    console.error(`\n${errors.length} non-fatal error(s):`);
    errors.forEach(e => console.error(`  - ${e}`));
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
