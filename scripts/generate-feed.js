#!/usr/bin/env node

// ============================================================================
// Follow Builders — Central Feed Generator (Upgraded Version)
// ============================================================================
// Uses AssemblyAI for podcast transcription and Apify for Twitter scraping.
// Env vars needed: APIFY_API_TOKEN, ASSEMBLYAI_API_KEY
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------
const ASSEMBLYAI_BASE = 'https://api.assemblyai.com/v2';
const APIFY_RUN_URL = 'https://api.apify.com/v2/acts/apidojo~tweet-scraper/runs';
const RSS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TWEET_LOOKBACK_HOURS = 24;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days
const MAX_TWEETS_PER_USER = 3;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------
async function loadState() {
  if (!existsSync(STATE_PATH)) return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenArticles) state.seenArticles = {};
    if (!state.seenVideos) state.seenVideos = {};
    if (!state.seenTweets) state.seenTweets = {};
    return state;
  } catch {
    return { seenTweets: {}, seenVideos: {}, seenArticles: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) { if (ts < cutoff) delete state.seenTweets[id]; }
  for (const [id, ts] of Object.entries(state.seenVideos)) { if (ts < cutoff) delete state.seenVideos[id]; }
  for (const [id, ts] of Object.entries(state.seenArticles)) { if (ts < cutoff) delete state.seenArticles[id]; }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Podcast Fetching (RSS + AssemblyAI) -------------------------------------
function parseRssFeed(xml) {
  const episodes = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    const guidMatch = block.match(/<guid[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/guid>/) || block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
    const guid = guidMatch ? guidMatch[1].trim() : null;

    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const link = linkMatch ? linkMatch[1].trim() : null;

    const enclosureMatch = block.match(/<enclosure[^>]*url="([^"]+)"/i);
    const audioUrl = enclosureMatch ? enclosureMatch[1].trim() : null;

    if (guid && audioUrl) {
      episodes.push({ title, guid, publishedAt, link, audioUrl });
    }
  }
  return episodes;
}

async function fetchAssemblyAITranscript(audioUrl, apiKey) {
  try {
    const submitRes = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
      method: 'POST',
      headers: { 'authorization': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, speech_model: 'universal-2' })
    });
    const submitData = await submitRes.json();
    if (submitData.error) return { error: submitData.error };
    const transcriptId = submitData.id;

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const pollRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${transcriptId}`, {
        headers: { 'authorization': apiKey }
      });
      const pollData = await pollRes.json();
      if (pollData.status === 'completed') return { transcript: pollData.text };
      if (pollData.status === 'error') return { error: pollData.error };
      console.error(`      AssemblyAI: processing (${i + 1}/20)...`);
    }
    return { error: 'Timeout waiting for transcript' };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchPodcastContent(podcasts, apiKey, state, errors) {
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);
  const allCandidates = [];

  for (const podcast of podcasts) {
    if (!podcast.rssUrl) continue;
    try {
      console.error(`  Fetching RSS for ${podcast.name}...`);
      const rssRes = await fetch(podcast.rssUrl, {
        headers: { 'User-Agent': RSS_USER_AGENT },
        signal: AbortSignal.timeout(30000)
      });
      if (!rssRes.ok) {
        console.error(`    RSS fetch failed: HTTP ${rssRes.status}`);
        continue;
      }
      const episodes = parseRssFeed(await rssRes.text());
      console.error(`    Parsed ${episodes.length} episodes with audio URLs`);

      for (const episode of episodes.slice(0, 3)) {
        if (state.seenVideos[episode.guid]) continue;
        allCandidates.push({ podcast, ...episode });
      }
    } catch (err) {
      errors.push(`Podcast: Error processing ${podcast.name}: ${err.message}`);
    }
  }

  const withinWindow = allCandidates
    .filter(v => !v.publishedAt || new Date(v.publishedAt) >= cutoff)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  console.error(`  ${withinWindow.length} episode(s) within ${PODCAST_LOOKBACK_HOURS}h window`);

  for (const selected of withinWindow) {
    console.error(`    Fetching transcript via AssemblyAI for "${selected.title}"...`);
    const result = await fetchAssemblyAITranscript(selected.audioUrl, apiKey);

    if (result.error || !result.transcript) {
      // Do NOT mark seenVideos on failure — allow retry next run
      console.error(`    Transcript error: ${result.error || 'empty'}, will retry next run`);
      continue;
    }

    state.seenVideos[selected.guid] = Date.now();
    return [{
      source: 'podcast',
      name: selected.podcast.name,
      title: selected.title,
      guid: selected.guid,
      url: selected.link || selected.podcast.url,
      publishedAt: selected.publishedAt,
      transcript: result.transcript
    }];
  }
  return [];
}

// -- X/Twitter Fetching (Apify async run) ------------------------------------

// Extract handle from tweet URL — most reliable regardless of actor field naming
// e.g. https://x.com/swyx/status/123 → "swyx"
function extractHandleFromUrl(tweet) {
  const url = tweet.url || tweet.twitterUrl || tweet.tweetUrl || '';
  const match = url.match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i);
  if (match && match[1] !== 'i') return match[1].toLowerCase();
  // Fallback: try common nested and flat field paths
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

async function fetchXContent(xAccounts, apifyToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);
  const handles = xAccounts.map(a => a.handle);

  try {
    console.error(`  Triggering Apify Twitter Scraper for ${handles.length} handles...`);
    const runRes = await fetch(`${APIFY_RUN_URL}?token=${apifyToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitterHandles: handles, maxItems: handles.length * 5 })
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
    console.error(`  Apify returned ${data.length} raw tweets`);

    // Debug: show structure of first tweet to aid future debugging
    if (data.length > 0) {
      const s = data[0];
      console.error(`  Sample top-level keys: ${Object.keys(s).join(', ')}`);
      console.error(`  Sample url field: ${s.url || s.twitterUrl || s.tweetUrl || '(none)'}`);
      console.error(`  Sample handle extracted: ${extractHandleFromUrl(s) || '(failed)'}`);
    }

    // Group by handle extracted from tweet URL
    const tweetsByHandle = {};
    for (const t of data) {
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
          quotedTweetId: t.quoteId || null
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
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const podcastsOnly = args.includes('--podcasts-only');
  const blogsOnly = args.includes('--blogs-only');

  const runTweets = tweetsOnly || (!podcastsOnly && !blogsOnly);
  const runPodcasts = podcastsOnly || (!tweetsOnly && !blogsOnly);

  const apifyToken = process.env.APIFY_API_TOKEN;
  const assemblyaiKey = process.env.ASSEMBLYAI_API_KEY;

  if (runTweets && !apifyToken) { console.error('APIFY_API_TOKEN not set'); process.exit(1); }
  if (runPodcasts && !assemblyaiKey) { console.error('ASSEMBLYAI_API_KEY not set'); process.exit(1); }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  if (runTweets) {
    console.error('Fetching X/Twitter content via Apify...');
    const xContent = await fetchXContent(sources.x_accounts, apifyToken, state, errors);
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
  }

  if (runPodcasts) {
    console.error('Fetching podcast content via AssemblyAI...');
    const podcasts = await fetchPodcastContent(sources.podcasts, assemblyaiKey, state, errors);
    const podcastFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: PODCAST_LOOKBACK_HOURS,
      podcasts,
      stats: { podcastEpisodes: podcasts.length },
      errors: errors.filter(e => e.startsWith('Podcast'))
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-podcasts.json'), JSON.stringify(podcastFeed, null, 2));
    console.error(`  feed-podcasts.json: ${podcasts.length} episodes`);
  }

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
