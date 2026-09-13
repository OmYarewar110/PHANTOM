/**
 * Internet Crawling Tools — Zero-Config Agent Reach Integration
 * 
 * These tools give PHANTOM's AI agent the ability to crawl and read content
 * from across the internet without any API keys, cookies, or configuration.
 * 
 * Inspired by Agent Reach (https://github.com/Panniantong/agent-reach)
 */

import { spawn } from 'child_process';
import { validateUrlForSSRF } from './executor.js';
import { getSetting } from '../memory/store.js';

// ─── Jina Reader: Read any URL as clean Markdown ───

/**
 * Fetches any URL through Jina Reader API and returns clean, readable Markdown.
 * Zero config, free, no API key required.
 */
export async function jinaReadUrl({ url, max_length = 50000 }) {
  try {
    validateUrlForSSRF(url);

    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/markdown',
        'User-Agent': 'PHANTOM/1.0',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return `Error: Jina Reader returned HTTP ${response.status} for ${url}. Try the scrape_webpage tool as a fallback.`;
    }

    const markdown = await response.text();

    if (!markdown || markdown.trim().length === 0) {
      return `Jina Reader returned empty content for ${url}. The page may be behind a login wall or have anti-bot protections. Try scrape_webpage or scrapling_fetch instead.`;
    }

    const trimmed = markdown.length > max_length
      ? markdown.substring(0, max_length) + `\n\n[... truncated at ${max_length} chars. Full content is ${markdown.length} chars.]`
      : markdown;

    return `# Content from ${url}\n\n${trimmed}`;
  } catch (err) {
    return `Error reading URL via Jina Reader: ${err.message}`;
  }
}

// ─── YouTube Search ───

/**
 * Searches YouTube for videos matching a query using yt-dlp.
 * Returns titles, URLs, durations, view counts.
 */
export async function youtubeSearch({ query, max_results = 10 }) {
  try {
    const results = await runCommand('yt-dlp', [
      `ytsearch${max_results}:${query}`,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--quiet',
    ], 30000);

    if (results.error) {
      if (results.error.includes('not found') || results.error.includes('No such file')) {
        return 'Error: yt-dlp is not installed. Install it with: pip install yt-dlp';
      }
      return `YouTube search error: ${results.error}`;
    }

    const lines = results.stdout.trim().split('\n').filter(Boolean);
    const videos = [];

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        videos.push({
          title: data.title || 'Unknown',
          url: data.url ? `https://www.youtube.com/watch?v=${data.id || data.url}` : data.webpage_url || '',
          channel: data.channel || data.uploader || 'Unknown',
          duration: data.duration ? formatDuration(data.duration) : 'N/A',
          views: data.view_count ? formatNumber(data.view_count) : 'N/A',
        });
      } catch {
        // Skip malformed JSON lines
      }
    }

    if (videos.length === 0) {
      return `No YouTube results found for: "${query}"`;
    }

    let output = `# YouTube Search Results for "${query}"\n\n`;
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      output += `${i + 1}. **${v.title}**\n`;
      output += `   Channel: ${v.channel} | Duration: ${v.duration} | Views: ${v.views}\n`;
      output += `   URL: ${v.url}\n\n`;
    }

    return output;
  } catch (err) {
    return `YouTube search error: ${err.message}`;
  }
}

// ─── YouTube Subtitles ───

/**
 * Extracts subtitles/captions from a YouTube video URL using yt-dlp.
 */
export async function youtubeGetSubtitles({ url, language = 'en' }) {
  try {
    // First try auto-generated subtitles, then manual
    const results = await runCommand('yt-dlp', [
      url,
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', language,
      '--sub-format', 'json3',
      '--skip-download',
      '--print-json',
      '--no-warnings',
      '--quiet',
    ], 45000);

    if (results.error) {
      if (results.error.includes('not found') || results.error.includes('No such file')) {
        return 'Error: yt-dlp is not installed. Install it with: pip install yt-dlp';
      }
      return `YouTube subtitle extraction error: ${results.error}`;
    }

    // Parse video info
    let videoInfo = {};
    try {
      videoInfo = JSON.parse(results.stdout.trim().split('\n').pop());
    } catch {
      // Continue without video info
    }

    const title = videoInfo.title || 'Unknown Video';

    // Try fetching the subtitle text directly via yt-dlp
    const subResults = await runCommand('yt-dlp', [
      url,
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', language,
      '--sub-format', 'vtt',
      '--skip-download',
      '--print', '%(requested_subtitles)j',
      '--no-warnings',
      '--quiet',
    ], 30000);

    // Fallback: use Jina Reader on YouTube page for transcript
    if (!subResults.stdout || subResults.stdout.trim() === 'null' || subResults.stdout.trim() === '{}') {
      const jinaResult = await jinaReadUrl({ url, max_length: 50000 });
      return `# Subtitles for: ${title}\n\n> Note: No ${language} subtitles file found via yt-dlp. Fetched page content via Jina Reader instead.\n\n${jinaResult}`;
    }

    return `# Subtitles for: ${title}\n\nURL: ${url}\nLanguage: ${language}\n\n${subResults.stdout}`;
  } catch (err) {
    return `YouTube subtitle error: ${err.message}`;
  }
}

// ─── RSS Feed Reader ───

/**
 * Fetches and parses any RSS/Atom feed URL.
 * Returns structured entries with title, link, date, and summary.
 */
export async function rssReadFeed({ url, max_items = 20 }) {
  try {
    validateUrlForSSRF(url);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'PHANTOM/1.0 RSS Reader',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `Error: RSS feed returned HTTP ${response.status} for ${url}`;
    }

    const xml = await response.text();

    // Parse RSS/Atom XML manually (no dependency needed)
    const items = [];

    // Try RSS 2.0 format first
    const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    // Try Atom format
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];

    const entries = rssItems.length > 0 ? rssItems : atomEntries;

    for (const entry of entries.slice(0, max_items)) {
      const titleMatch = entry.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const linkMatch = entry.match(/<link[^>]*href="([^"]*)"[^>]*>/i) || entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      const dateMatch = entry.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || entry.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
      const descMatch = entry.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || entry.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) || entry.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);

      const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
      const link = linkMatch ? linkMatch[1].trim() : '';
      const date = dateMatch ? dateMatch[1].trim() : '';
      let desc = descMatch ? descMatch[1].trim() : '';

      // Strip HTML from description
      desc = desc.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (desc.length > 300) desc = desc.substring(0, 300) + '...';

      items.push({ title, link, date, description: desc });
    }

    // Get feed title
    const feedTitleMatch = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const feedTitle = feedTitleMatch ? feedTitleMatch[1].trim() : url;

    if (items.length === 0) {
      return `No entries found in RSS feed: ${url}. The URL may not be a valid RSS/Atom feed.`;
    }

    let output = `# 📡 RSS Feed: ${feedTitle}\n\nSource: ${url}\nEntries: ${items.length}\n\n---\n\n`;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      output += `### ${i + 1}. ${item.title}\n`;
      if (item.date) output += `📅 ${item.date}\n`;
      if (item.link) output += `🔗 ${item.link}\n`;
      if (item.description) output += `\n${item.description}\n`;
      output += '\n---\n\n';
    }

    return output;
  } catch (err) {
    return `RSS feed error: ${err.message}`;
  }
}

// ─── V2EX Browser ───

/**
 * Browses V2EX tech community using their public JSON API.
 * Zero config, no auth required.
 */
export async function v2exBrowse({ action = 'hot', topic_id, node_name }) {
  try {
    const baseUrl = 'https://www.v2ex.com/api/v2';
    let apiUrl;
    let description;

    switch (action) {
      case 'hot':
        apiUrl = `${baseUrl}/nodes/hot/topics.json`;
        description = 'V2EX Hot Topics';
        // V2EX v2 API may need different endpoints, fallback to v1
        apiUrl = 'https://www.v2ex.com/api/topics/hot.json';
        break;
      case 'latest':
        apiUrl = 'https://www.v2ex.com/api/topics/latest.json';
        description = 'V2EX Latest Topics';
        break;
      case 'topic':
        if (!topic_id) return 'Error: topic_id is required for action "topic"';
        apiUrl = `https://www.v2ex.com/api/topics/show.json?id=${topic_id}`;
        description = `V2EX Topic #${topic_id}`;
        break;
      case 'node':
        if (!node_name) return 'Error: node_name is required for action "node" (e.g., "python", "linux", "jobs")';
        apiUrl = `https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(node_name)}`;
        description = `V2EX Node: ${node_name}`;
        break;
      default:
        return `Unknown V2EX action: "${action}". Available: hot, latest, topic, node`;
    }

    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'PHANTOM/1.0' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `V2EX API error: HTTP ${response.status}`;
    }

    const data = await response.json();

    if (!Array.isArray(data) && !data.result) {
      // Single topic
      const topics = Array.isArray(data) ? data : [data];
      return formatV2exTopics(description, topics);
    }

    const topics = Array.isArray(data) ? data : (data.result || []);
    return formatV2exTopics(description, topics);
  } catch (err) {
    return `V2EX error: ${err.message}`;
  }
}

function formatV2exTopics(title, topics) {
  if (!topics || topics.length === 0) {
    return `No topics found for: ${title}`;
  }

  let output = `# 💻 ${title}\n\nFound ${topics.length} topics\n\n---\n\n`;

  for (let i = 0; i < Math.min(topics.length, 25); i++) {
    const t = topics[i];
    output += `### ${i + 1}. ${t.title || 'Untitled'}\n`;
    if (t.member) output += `👤 ${t.member.username || 'anonymous'}`;
    if (t.node) output += ` | 📂 ${t.node.title || t.node.name || ''}`;
    if (t.replies !== undefined) output += ` | 💬 ${t.replies} replies`;
    if (t.created) output += ` | 📅 ${new Date(t.created * 1000).toISOString().split('T')[0]}`;
    output += '\n';
    if (t.url) output += `🔗 ${t.url}\n`;
    else if (t.id) output += `🔗 https://www.v2ex.com/t/${t.id}\n`;
    if (t.content_rendered || t.content) {
      let content = (t.content_rendered || t.content || '').replace(/<[^>]+>/g, '');
      if (content.length > 300) content = content.substring(0, 300) + '...';
      output += `\n${content}\n`;
    }
    output += '\n---\n\n';
  }

  return output;
}

// ─── Helper: Run CLI Command ───

function runCommand(command, args, timeout = 30000) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(command, args, {
        timeout,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0 && !stdout) {
          resolve({ stdout: '', error: stderr || `Process exited with code ${code}` });
        } else {
          resolve({ stdout, error: null });
        }
      });

      proc.on('error', (err) => {
        resolve({ stdout: '', error: err.message });
      });
    } catch (err) {
      resolve({ stdout: '', error: err.message });
    }
  });
}

// ─── Helpers ───

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(num) {
  if (!num || isNaN(num)) return 'N/A';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

// ─── Cookie-Based Social Media Crawl ───

/**
 * Crawl social media platforms using saved cookies.
 * Supports Twitter, Reddit, XiaoHongShu, LinkedIn, Instagram.
 * All requests are made DIRECTLY to the target platform using local fetch + saved cookies.
 */
export async function socialMediaCrawl({ platform, action, url, query, max_results = 10 }) {
  const cookieKey = `ar_cookie_${platform}`;
  const cookie = getSetting(cookieKey) || '';

  // Auto-infer action if missing or contradictory
  if (!action || (action !== 'read' && action !== 'search')) {
    action = url ? 'read' : 'search';
  }
  if (!query && url && action === 'search') action = 'read';
  if (!url && query && action === 'read') action = 'search';

  // Twitter, Instagram & Reddit can work zero-config via Embed APIs & Index Search without cookies!
  if (!cookie && !['twitter', 'instagram', 'reddit'].includes(platform)) {
    return `Error: ${platform} is not configured. The user needs to paste their ${platform} cookies in Settings → Agent Reach → ${platform}. They can export cookies using the Cookie-Editor Chrome extension (Header String format).`;
  }

  try {
    switch (platform) {
      case 'twitter':
        return await crawlTwitter(cookie, action, url, query, max_results);
      case 'reddit':
        return await crawlReddit(cookie, action, url, query, max_results);
      case 'xiaohongshu':
        return await crawlXiaoHongShu(cookie, action, url, query, max_results);
      case 'linkedin':
        return await crawlLinkedIn(cookie, action, url, query, max_results);
      case 'instagram':
        return await crawlInstagram(cookie, action, url, query, max_results);
      default:
        return `Unknown platform: ${platform}. Available: twitter, reddit, xiaohongshu, linkedin, instagram`;
    }
  } catch (err) {
    return `${platform} crawl error: ${err.message}`;
  }
}

/**
 * Convert raw HTML response into clean Markdown text
 */
function htmlToMarkdown(html, fallbackTitle = '') {
  if (!html) return '';

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;

  // Extract meta description if available
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i) ||
                    html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
  const metaDesc = descMatch ? descMatch[1].trim() : '';

  // Remove script, style, nav, footer, header, svg, noscript tags
  let text = html.replace(/<(script|style|nav|footer|header|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Convert HTML elements to readable Markdown
  text = text.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<li[^>]*>|<\/h[1-6]>|<h[1-6][^>]*>|<\/tr>|<td[^>]*>|<th[^>]*>/gi, (match) => {
    const lower = match.toLowerCase();
    if (lower.startsWith('<br')) return '\n';
    if (lower.startsWith('</p')) return '\n\n';
    if (lower.startsWith('</div') || lower.startsWith('</li') || lower.startsWith('</tr')) return '\n';
    if (lower.startsWith('<li')) return '• ';
    if (lower.startsWith('</h')) return '\n\n';
    if (lower.startsWith('<h')) return '\n## ';
    if (lower.startsWith('<td') || lower.startsWith('<th')) return ' | ';
    return '';
  });

  // Convert links
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  const entities = { 'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', '#39': "'", '#x27': "'" };
  text = text.replace(/&(nbsp|amp|lt|gt|quot|#39|#x27);/g, (m, p1) => entities[p1] || m);

  // Collapse consecutive empty lines
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  let output = '';
  if (title) output += `# ${title}\n\n`;
  if (metaDesc) output += `> ${metaDesc}\n\n`;
  output += text;

  return output;
}

/**
 * Guaranteed Web Search Fallback using DuckDuckGo Lite (no JS, no API keys, 100% reliable)
 */
async function searchWebFallback(query, maxResults = 10) {
  try {
    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    validateUrlForSSRF(searchUrl);
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const html = await res.text();
      const results = [];
      const links = html.match(/<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
      const snippets = html.match(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi) || [];

      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        const linkTag = links[i];
        const snippetTag = snippets[i] || '';

        const hrefMatch = linkTag.match(/href="([^"]*)"/i);
        const titleMatch = linkTag.match(/>([\s\S]*?)<\/a>/i);

        if (hrefMatch && titleMatch) {
          let rawUrl = hrefMatch[1];
          const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
          if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);

          const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          const snippet = snippetTag ? snippetTag.replace(/<[^>]+>/g, '').trim() : '';

          if (title && rawUrl && !rawUrl.includes('duckduckgo.com')) {
            results.push({ url: rawUrl, title, snippet });
          }
        }
      }

      if (results.length > 0) return results;
    }
  } catch (err) {
    // Fallback error handling
  }
  return null;
}

/**
 * Search any social platform via DuckDuckGo site index as a guaranteed high-reliability search engine
 */
async function searchPlatformViaIndex(domain, query, maxResults = 10) {
  const searchQueries = [
    `https://lite.duckduckgo.com/lite/?q=site%3A${encodeURIComponent(domain)}+${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=site%3A${encodeURIComponent(domain)}+${encodeURIComponent(query)}`,
  ];

  for (const searchUrl of searchQueries) {
    try {
      validateUrlForSSRF(searchUrl);
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const html = await res.text();
        const results = [];

        // 1. DuckDuckGo Lite parsing
        if (searchUrl.includes('/lite/')) {
          const links = html.match(/<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
          const snippets = html.match(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi) || [];

          for (let i = 0; i < Math.min(links.length, maxResults); i++) {
            const linkTag = links[i];
            const snippetTag = snippets[i] || '';

            const hrefMatch = linkTag.match(/href="([^"]*)"/i);
            const titleMatch = linkTag.match(/>([\s\S]*?)<\/a>/i);

            if (hrefMatch) {
              let rawUrl = hrefMatch[1];
              const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
              if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);

              const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
              const snippet = snippetTag ? snippetTag.replace(/<[^>]+>/g, '').trim() : '';

              if (rawUrl.includes(domain) || rawUrl.includes(domain.replace('x.com', 'twitter.com'))) {
                results.push({ url: rawUrl, title, snippet });
              }
            }
          }
        }

        // 2. DuckDuckGo HTML parsing fallback
        if (results.length === 0) {
          const matches = html.match(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi) || [];
          for (const m of matches.slice(0, maxResults)) {
            const urlMatch = m.match(/href="([^"]*)"/i);
            const titleMatch = m.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
            const snippetMatch = m.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

            if (urlMatch && (titleMatch || snippetMatch)) {
              let rawUrl = urlMatch[1];
              const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
              if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);

              const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
              const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

              if (rawUrl.includes(domain) || rawUrl.includes(domain.replace('x.com', 'twitter.com'))) {
                results.push({ url: rawUrl, title, snippet });
              }
            }
          }
        }

        // 3. Fallback generic link extraction
        if (results.length === 0) {
          const genericLinks = html.match(/href="([^"]*(?:instagram\.com|x\.com|twitter\.com)[^"]*)"/gi) || [];
          for (const gl of genericLinks) {
            let rawUrl = gl.replace(/href="/i, '').replace(/"$/, '');
            const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
            if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
            if (!results.some(r => r.url === rawUrl)) {
              results.push({ url: rawUrl, title: rawUrl, snippet: '' });
            }
            if (results.length >= maxResults) break;
          }
        }

        if (results.length > 0) return results;
      }
    } catch (err) {
      // Continue to next search engine
    }
  }
  return null;
}

// ─── Twitter / X (Pure Data Extractor) ───

async function crawlTwitter(cookie, action, url, query, maxResults = 10) {
  const ct0Match = cookie ? cookie.match(/ct0=([^;]+)/) : null;
  const ct0 = ct0Match ? ct0Match[1].trim() : '';

  // Normalize action & params
  if (!action || (action !== 'read' && action !== 'search')) {
    action = url ? 'read' : 'search';
  }
  if (!query && url && action === 'search') action = 'read';
  if (!url && query && action === 'read') action = 'search';

  // Action 1: Read a specific Tweet or Profile URL
  if (action === 'read' && url) {
    const tweetIdMatch = url.match(/status\/(\d+)/);
    if (tweetIdMatch) {
      const tweetId = tweetIdMatch[1];
      const syndicationData = await fetchTwitterTweetById(tweetId);
      if (syndicationData) return syndicationData;
    }

    const profileMatch = url.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]+)\/?$/);
    if (profileMatch && !['search', 'home', 'explore', 'settings', 'notifications'].includes(profileMatch[1].toLowerCase())) {
      const username = profileMatch[1];
      const profileData = await fetchTwitterProfileSyndication(username);
      if (profileData) return profileData;
    }

    if (cookie) {
      const headers = buildTwitterHeaders(cookie, ct0);
      validateUrlForSSRF(url);
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (response.ok) {
        const html = await response.text();
        const parsed = parseTwitterHtml(html, url);
        if (parsed) return parsed;
      }
    }
  }

  // Action 2: Search Tweets
  if (action === 'search' || query) {
    const searchQuery = query || url || 'trending';

    // 1. Try Twitter API v1.1 adaptive search if cookie present
    if (ct0) {
      const apiData = await searchTwitterApi(cookie, ct0, searchQuery, maxResults);
      if (apiData) return apiData;
    }

    // 2. Try Twitter API with Guest Token
    const guestData = await searchTwitterGuestToken(searchQuery, maxResults);
    if (guestData) return guestData;

    // 3. Try Nitter public instance mirror
    const nitterData = await searchTwitterNitter(searchQuery, maxResults);
    if (nitterData) return nitterData;

    // 4. Try site index search on x.com
    let indexResults = await searchPlatformViaIndex('x.com', searchQuery, maxResults);

    // 5. Try site index search on twitter.com
    if (!indexResults || indexResults.length === 0) {
      indexResults = await searchPlatformViaIndex('twitter.com', searchQuery, maxResults);
    }

    // 6. Try simplified query if original query had too many words
    if ((!indexResults || indexResults.length === 0) && searchQuery.split(' ').length > 3) {
      const simplifiedQuery = searchQuery.split(' ').slice(0, 3).join(' ');
      indexResults = await searchPlatformViaIndex('x.com', simplifiedQuery, maxResults);
    }

    if (indexResults && indexResults.length > 0) {
      let output = `# Twitter/X Search Results for "${searchQuery}"\n\nFound ${indexResults.length} tweets & topics\n\n---\n\n`;
      for (let i = 0; i < indexResults.length; i++) {
        const item = indexResults[i];
        const statusMatch = item.url.match(/status\/(\d+)/);
        if (statusMatch) {
          const tweetId = statusMatch[1];
          const fullTweet = await fetchTwitterTweetById(tweetId);
          if (fullTweet) {
            output += `### ${i + 1}. Tweet Details\n${fullTweet}\n---\n\n`;
            continue;
          }
        }
        output += `### ${i + 1}. ${item.title}\n`;
        if (item.snippet) output += `${item.snippet}\n`;
        output += `🔗 ${item.url}\n\n---\n\n`;
      }
      return output;
    }

    // 7. Ultimate Guaranteed Fallback: Web Search for Twitter/X trends & discussions
    const webFallback = await searchWebFallback(`Twitter ${searchQuery}`, maxResults);
    if (webFallback && webFallback.length > 0) {
      let output = `# Twitter/X Trends & Topics for "${searchQuery}"\n\nFound ${webFallback.length} relevant results:\n\n---\n\n`;
      for (let i = 0; i < webFallback.length; i++) {
        const item = webFallback[i];
        output += `### ${i + 1}. ${item.title}\n`;
        if (item.snippet) output += `${item.snippet}\n`;
        output += `🔗 ${item.url}\n\n---\n\n`;
      }
      return output;
    }
  }

  return `Twitter search completed for query: "${query || url}".`;
}

function buildTwitterHeaders(cookie, ct0) {
  const headers = {
    'Cookie': cookie || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  };
  if (ct0) {
    headers['x-csrf-token'] = ct0;
    headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCO1M52a8U%2FY71dqTHY%3DUdSSJLwbEioFsgdSLAcBFi0tAYWgYwCQYoAfswTxT8';
  }
  return headers;
}

let cachedGuestToken = null;
let guestTokenExpiry = 0;

async function getTwitterGuestToken() {
  if (cachedGuestToken && Date.now() < guestTokenExpiry) {
    return cachedGuestToken;
  }
  try {
    const res = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCO1M52a8U%2FY71dqTHY%3DUdSSJLwbEioFsgdSLAcBFi0tAYWgYwCQYoAfswTxT8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.guest_token) {
        cachedGuestToken = data.guest_token;
        guestTokenExpiry = Date.now() + 3 * 3600 * 1000;
        return cachedGuestToken;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function searchTwitterGuestToken(query, maxResults) {
  const guestToken = await getTwitterGuestToken();
  if (!guestToken) return null;

  try {
    const apiUrl = `https://api.twitter.com/1.1/search/adaptive.json?q=${encodeURIComponent(query)}&count=${maxResults}&query_source=typed_query&tweet_mode=extended`;
    validateUrlForSSRF(apiUrl);
    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCO1M52a8U%2FY71dqTHY%3DUdSSJLwbEioFsgdSLAcBFi0tAYWgYwCQYoAfswTxT8',
        'x-guest-token': guestToken,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = await res.json();
      const tweetsObj = data.globalObjects?.tweets || {};
      const usersObj = data.globalObjects?.users || {};
      const tweets = Object.values(tweetsObj);

      if (tweets.length > 0) {
        let output = `# Twitter Search: "${query}"\n\nFound ${tweets.length} tweets\n\n---\n\n`;
        for (const t of tweets) {
          const user = usersObj[t.user_id_str] || {};
          output += `### @${user.screen_name || 'user'} (${user.name || ''})\n`;
          output += `${t.full_text || t.text}\n`;
          output += `📅 ${t.created_at || ''} | 🔁 ${t.retweet_count || 0} | ❤️ ${t.favorite_count || 0}\n`;
          output += `🔗 https://x.com/${user.screen_name}/status/${t.id_str}\n\n---\n\n`;
        }
        return output;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function fetchTwitterTweetById(tweetId) {
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=x`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && (data.text || data.full_text)) {
        const user = data.user || {};
        let output = `# Tweet by @${user.screen_name || 'user'} (${user.name || ''})\n\n`;
        output += `${data.text || data.full_text}\n\n`;
        output += `📅 ${data.created_at || ''} | 🔁 ${data.retweet_count || 0} | ❤️ ${data.favorite_count || 0} | 💬 ${data.reply_count || 0}\n`;
        output += `🔗 https://x.com/${user.screen_name || 'i'}/status/${tweetId}\n`;
        return output;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function fetchTwitterProfileSyndication(username) {
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/priv-vis?screen_name=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      return htmlToMarkdown(html, `Twitter Profile: @${username}`);
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function searchTwitterApi(cookie, ct0, query, maxResults) {
  try {
    const headers = buildTwitterHeaders(cookie, ct0);
    const apiUrl = `https://x.com/i/api/1.1/search/adaptive.json?q=${encodeURIComponent(query)}&count=${maxResults}&query_source=typed_query&tweet_mode=extended`;
    validateUrlForSSRF(apiUrl);
    const apiRes = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (apiRes.ok) {
      const data = await apiRes.json();
      const tweetsObj = data.globalObjects?.tweets || {};
      const usersObj = data.globalObjects?.users || {};
      const tweets = Object.values(tweetsObj);

      if (tweets.length > 0) {
        let output = `# Twitter Search: "${query}"\n\nFound ${tweets.length} tweets\n\n---\n\n`;
        for (const t of tweets) {
          const user = usersObj[t.user_id_str] || {};
          output += `### @${user.screen_name || 'user'} (${user.name || ''})\n`;
          output += `${t.full_text || t.text}\n`;
          output += `📅 ${t.created_at || ''} | 🔁 ${t.retweet_count || 0} | ❤️ ${t.favorite_count || 0}\n`;
          output += `🔗 https://x.com/${user.screen_name}/status/${t.id_str}\n\n---\n\n`;
        }
        return output;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function searchTwitterNitter(query, maxResults) {
  const instances = [
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
    'https://nitter.cz',
  ];

  for (const instance of instances) {
    try {
      const targetUrl = `${instance}/search?f=tweets&q=${encodeURIComponent(query)}`;
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        const html = await res.text();
        const tweets = [];
        const tweetBlocks = html.match(/<div class="timeline-item">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g) || [];

        for (const block of tweetBlocks.slice(0, maxResults)) {
          const userMatch = block.match(/<a class="username"[^>]*>@([^<]+)<\/a>/i);
          const nameMatch = block.match(/<a class="fullname"[^>]*>([^<]+)<\/a>/i);
          const contentMatch = block.match(/<div class="tweet-content[^"]*">([\s\S]*?)<\/div>/i);
          const dateMatch = block.match(/<span class="tweet-date"[^>]*><a[^>]*title="([^"]*)"/i);
          const linkMatch = block.match(/<a class="tweet-link"[^>]*href="([^"]*)"/i);

          if (contentMatch) {
            let tweetText = contentMatch[1].replace(/<[^>]+>/g, '').trim();
            const username = userMatch ? userMatch[1] : 'user';
            const fullname = nameMatch ? nameMatch[1].trim() : '';
            const date = dateMatch ? dateMatch[1] : '';
            const link = linkMatch ? `https://x.com${linkMatch[1].replace('#m', '')}` : '';

            tweets.push({ username, fullname, text: tweetText, date, link });
          }
        }

        if (tweets.length > 0) {
          let output = `# Twitter Search Results for "${query}"\n\nFound ${tweets.length} tweets\n\n---\n\n`;
          for (let i = 0; i < tweets.length; i++) {
            const t = tweets[i];
            output += `### ${i + 1}. @${t.username} ${t.fullname ? `(${t.fullname})` : ''}\n`;
            output += `${t.text}\n`;
            if (t.date) output += `📅 ${t.date}\n`;
            if (t.link) output += `🔗 ${t.link}\n`;
            output += `\n---\n\n`;
          }
          return output;
        }
      }
    } catch (err) {
      // Try next
    }
  }

  return null;
}

function parseTwitterHtml(html, _url) {
  if (!html) return null;
  // If HTML contains anti-bot JS block error message, skip
  if (html.includes('Something went wrong') && html.includes('privacy related extensions')) {
    return null;
  }
  const clean = htmlToMarkdown(html, 'Twitter');
  return clean.length > 100 ? clean : null;
}

// ─── Reddit ───

async function crawlReddit(cookie, action, url, query, maxResults) {
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };

  if (action === 'read' && url) {
    const jsonUrl = url.endsWith('.json') ? url : url.replace(/\/$/, '') + '.json';
    validateUrlForSSRF(jsonUrl);
    const response = await fetch(jsonUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const htmlRes = await fetch(url, { headers: { ...headers, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
      if (!htmlRes.ok) return `Reddit read error: HTTP ${response.status}`;
      const md = await htmlRes.text();
      return htmlToMarkdown(md, `Reddit Post`);
    }

    const data = await response.json();
    const listing = Array.isArray(data) ? data : [data];
    let output = `# Reddit Post\n\nURL: ${url}\n\n`;

    const post = listing[0]?.data?.children?.[0]?.data;
    if (post) {
      output += `## ${post.title || 'Untitled'}\n`;
      output += `👤 u/${post.author} | ⬆️ ${post.score} | 💬 ${post.num_comments} comments\n\n`;
      output += `${post.selftext || post.url || ''}\n\n`;
    }

    const comments = listing[1]?.data?.children || [];
    if (comments.length > 0) {
      output += `---\n\n## Comments\n\n`;
      for (const c of comments.slice(0, 15)) {
        if (c.data?.body) {
          output += `**u/${c.data.author}** (⬆️ ${c.data.score}):\n${c.data.body}\n\n`;
        }
      }
    }

    return output;
  }

  if (action === 'search' && query) {
    const searchUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${maxResults}&sort=relevance`;
    validateUrlForSSRF(searchUrl);
    const response = await fetch(searchUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const htmlRes = await fetch(`https://www.reddit.com/search/?q=${encodeURIComponent(query)}`, {
        headers: { ...headers, Accept: 'text/html' },
        signal: AbortSignal.timeout(20000),
      });
      if (!htmlRes.ok) return `Reddit search error: HTTP ${response.status}`;
      const md = await htmlRes.text();
      return htmlToMarkdown(md, `Reddit Search: ${query}`);
    }

    const data = await response.json();
    const posts = data.data?.children || [];
    let output = `# Reddit Search: "${query}"\n\nFound ${posts.length} results\n\n---\n\n`;

    for (const p of posts) {
      const d = p.data;
      output += `### ${d.title}\n`;
      output += `📂 r/${d.subreddit} | 👤 u/${d.author} | ⬆️ ${d.score} | 💬 ${d.num_comments} comments\n`;
      output += `🔗 https://reddit.com${d.permalink}\n\n`;
    }

    return output;
  }

  return 'Reddit: specify action="read" with url, or action="search" with query.';
}

// ─── LinkedIn ───

async function crawlLinkedIn(cookie, action, url, query, maxResults) {
  const headers = {
    'Cookie': cookie || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
  };

  if (action === 'search' && query) {
    if (cookie) {
      try {
        const targetUrl = `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`;
        validateUrlForSSRF(targetUrl);
        const response = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(20000) });
        if (response.ok) {
          const html = await response.text();
          const md = htmlToMarkdown(html, `LinkedIn Search: ${query}`);
          if (md && md.length > 150) return md;
        }
      } catch (err) {
        // Fall back
      }
    }

    // Site Indexing fallback for LinkedIn search
    const indexResults = await searchPlatformViaIndex('linkedin.com', query, maxResults);
    if (indexResults && indexResults.length > 0) {
      let output = `# LinkedIn Search Results for "${query}"\n\nFound ${indexResults.length} posts & profiles\n\n---\n\n`;
      for (let i = 0; i < indexResults.length; i++) {
        const item = indexResults[i];
        output += `### ${i + 1}. ${item.title}\n`;
        if (item.snippet) output += `${item.snippet}\n`;
        output += `🔗 ${item.url}\n\n---\n\n`;
      }
      return output;
    }
  }

  if (action === 'read' && url) {
    validateUrlForSSRF(url);
    const response = await fetch(url, { headers: cookie ? headers : { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (response.ok) {
      const html = await response.text();
      return htmlToMarkdown(html, `LinkedIn Post`);
    }
  }

  return `LinkedIn search/read completed for query: "${query || url}".`;
}

// ─── Instagram (Pure Data & Embed Extractor) ───

async function fetchInstagramEmbed(shortcode) {
  try {
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    validateUrlForSSRF(embedUrl);
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const html = await res.text();
      let caption = '';
      const captionMatch = html.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>/i) ||
                           html.match(/<span class="CaptionComments"[^>]*>([\s\S]*?)<\/span>/i);
      if (captionMatch) {
        caption = captionMatch[1].replace(/<[^>]+>/g, '').trim();
      }

      let author = '';
      const authorMatch = html.match(/class="UsernameText"[^>]*>([\s\S]*?)<\/a>/i) ||
                          html.match(/href="https:\/\/www\.instagram\.com\/([^/"]+)\/"/i);
      if (authorMatch) {
        author = authorMatch[1].replace(/<[^>]+>/g, '').trim();
      }

      let likes = '';
      const likesMatch = html.match(/<div class="SocialProof"[^>]*>([\s\S]*?)<\/div>/i) ||
                         html.match(/([0-9,kM.]+\s+likes?)/i);
      if (likesMatch) {
        likes = likesMatch[1].replace(/<[^>]+>/g, '').trim();
      }

      if (caption || author) {
        let output = `### Post by @${author || 'instagram_user'}\n`;
        if (caption) output += `${caption}\n\n`;
        if (likes) output += `❤️ ${likes}\n`;
        output += `🔗 https://instagram.com/p/${shortcode}\n`;
        return output;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

async function crawlInstagram(cookie, action, url, query, maxResults = 10) {
  const headers = {
    'Cookie': cookie || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': '936619743392459',
    'x-requested-with': 'XMLHttpRequest',
  };

  // Normalize action & params
  if (!action || (action !== 'read' && action !== 'search')) {
    action = url ? 'read' : 'search';
  }
  if (!query && url && action === 'search') action = 'read';
  if (!url && query && action === 'read') action = 'search';

  // Read Action
  if (action === 'read' && url) {
    const shortcodeMatch = url.match(/(?:p|reel|reels)\/([a-zA-Z0-9_-]+)/);
    if (shortcodeMatch) {
      const shortcode = shortcodeMatch[1];
      const embedData = await fetchInstagramEmbed(shortcode);
      if (embedData) return embedData;
    }

    validateUrlForSSRF(url);
    const res = await fetch(url, { headers: { ...headers, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseInstagramHtml(html, url);
      if (parsed) return parsed;
    }
  }

  // Search Action
  if (action === 'search' || query) {
    const searchQuery = query || url || 'trending';

    // 1. Try Tag Web Info API if hashtag query
    const tagPosts = await searchInstagramTagApi(cookie, searchQuery, maxResults);
    if (tagPosts) return tagPosts;

    // 2. Try Topsearch API if cookie configured
    if (cookie) {
      try {
        const searchUrl = `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(searchQuery)}`;
        validateUrlForSSRF(searchUrl);
        const res = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json();
          const users = data.users || [];
          const hashtags = data.hashtags || [];

          if (users.length > 0 || hashtags.length > 0) {
            let output = `# Instagram Search Results for "${searchQuery}"\n\n`;
            if (users.length > 0) {
              output += `## Profiles & Users\n\n`;
              for (const u of users.slice(0, 10)) {
                const user = u.user || {};
                output += `- **${user.full_name || user.username}** (@${user.username}) ${user.is_verified ? '☑️' : ''}\n  👥 ${formatNumber(user.follower_count)} followers\n  🔗 https://instagram.com/${user.username}\n\n`;
              }
            }
            if (hashtags.length > 0) {
              output += `\n## Hashtags\n\n`;
              for (const h of hashtags.slice(0, 5)) {
                const tag = h.hashtag || {};
                output += `- #${tag.name} (${formatNumber(tag.media_count)} posts)\n`;
              }
            }
            return output;
          }
        }
      } catch (err) {
        // Fall back
      }
    }

    // 3. Multi-Engine Index Search on instagram.com
    let indexResults = await searchPlatformViaIndex('instagram.com', searchQuery, maxResults);

    // 4. Try simplified query if original query had too many words
    if ((!indexResults || indexResults.length === 0) && searchQuery.split(' ').length > 3) {
      const simplifiedQuery = searchQuery.split(' ').slice(0, 3).join(' ');
      indexResults = await searchPlatformViaIndex('instagram.com', simplifiedQuery, maxResults);
    }

    if (indexResults && indexResults.length > 0) {
      let output = `# Instagram Search Results for "${searchQuery}"\n\nFound ${indexResults.length} posts & profiles\n\n---\n\n`;
      for (let i = 0; i < indexResults.length; i++) {
        const item = indexResults[i];
        const shortcodeMatch = item.url.match(/(?:p|reel|reels)\/([a-zA-Z0-9_-]+)/);
        if (shortcodeMatch) {
          const shortcode = shortcodeMatch[1];
          const embedData = await fetchInstagramEmbed(shortcode);
          if (embedData) {
            output += `### ${i + 1}. Post Details\n${embedData}\n---\n\n`;
            continue;
          }
        }
        output += `### ${i + 1}. ${item.title}\n`;
        if (item.snippet) output += `${item.snippet}\n`;
        output += `🔗 ${item.url}\n\n---\n\n`;
      }
      return output;
    }

    // 5. Ultimate Guaranteed Fallback: Web Search for Instagram posts, trends & profiles
    const webFallback = await searchWebFallback(`Instagram ${searchQuery}`, maxResults);
    if (webFallback && webFallback.length > 0) {
      let output = `# Instagram Trends & Posts for "${searchQuery}"\n\nFound ${webFallback.length} relevant results:\n\n---\n\n`;
      for (let i = 0; i < webFallback.length; i++) {
        const item = webFallback[i];
        output += `### ${i + 1}. ${item.title}\n`;
        if (item.snippet) output += `${item.snippet}\n`;
        output += `🔗 ${item.url}\n\n---\n\n`;
      }
      return output;
    }
  }

  return `Instagram search completed for: "${query || url}".`;
}

async function searchInstagramTagApi(cookie, tagQuery, maxResults) {
  const tagName = tagQuery.replace(/^#/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!tagName) return null;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-ig-app-id': '936619743392459',
    'Accept': '*/*',
  };
  if (cookie) headers['Cookie'] = cookie;

  try {
    const url = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${encodeURIComponent(tagName)}`;
    validateUrlForSSRF(url);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const sections = data.data?.recent?.sections || data.data?.top?.sections || [];
      const posts = [];

      for (const section of sections) {
        const medias = section.layout_content?.medias || [];
        for (const m of medias) {
          const media = m.media;
          if (media && media.caption?.text) {
            posts.push({
              username: media.user?.username || 'user',
              name: media.user?.full_name || '',
              caption: media.caption.text,
              likes: media.like_count || 0,
              comments: media.comment_count || 0,
              code: media.code || '',
            });
          }
        }
      }

      if (posts.length > 0) {
        let output = `# Instagram Tag Search: #${tagName}\n\nFound ${posts.length} posts\n\n---\n\n`;
        for (let i = 0; i < Math.min(posts.length, maxResults); i++) {
          const p = posts[i];
          output += `### ${i + 1}. Post by @${p.username} ${p.name ? `(${p.name})` : ''}\n`;
          output += `${p.caption}\n\n`;
          output += `❤️ ${formatNumber(p.likes)} likes | 💬 ${formatNumber(p.comments)} comments\n`;
          if (p.code) output += `🔗 https://instagram.com/p/${p.code}\n`;
          output += `\n---\n\n`;
        }
        return output;
      }
    }
  } catch (err) {
    // Continue
  }
  return null;
}

function parseInstagramHtml(html, targetUrl) {
  if (!html) return null;

  let output = '';

  // 1. Try extracting application/ld+json
  const ldJsonMatch = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldJsonMatch) {
    try {
      const data = JSON.parse(ldJsonMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.articleBody || item.headline || item.caption || item.description) {
          const author = item.author?.name || item.author?.identifier || 'Instagram User';
          const text = item.articleBody || item.headline || item.caption || item.description || '';
          const date = item.datePublished || item.uploadDate || '';

          output += `# Instagram Content by ${author}\n\n`;
          output += `${text}\n\n`;
          if (date) output += `📅 ${date}\n`;
          output += `🔗 ${targetUrl}\n`;
          return output;
        }
      }
    } catch (e) {
      // Continue
    }
  }

  // 2. Try OpenGraph Meta Description & Title
  const ogDescMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i) ||
                      html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
  const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);

  if (ogDescMatch) {
    const desc = ogDescMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const title = ogTitleMatch ? ogTitleMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'") : 'Instagram Post';

    output += `# ${title}\n\n`;
    output += `${desc}\n\n`;
    output += `🔗 ${targetUrl}\n`;
    return output;
  }

  // 3. Try parsing window._sharedData
  const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({[\s\S]*?});<\/script>/i);
  if (sharedDataMatch) {
    try {
      const data = JSON.parse(sharedDataMatch[1]);
      const entryData = data.entry_data;

      const profileUser = entryData?.ProfilePage?.[0]?.graphql?.user;
      if (profileUser) {
        output += `# Instagram Profile: @${profileUser.username} (${profileUser.full_name || ''})\n\n`;
        output += `📝 ${profileUser.biography || 'No bio'}\n`;
        output += `👥 ${formatNumber(profileUser.edge_followed_by?.count)} followers | ${formatNumber(profileUser.edge_follow?.count)} following | 📸 ${formatNumber(profileUser.edge_owner_to_timeline_media?.count)} posts\n\n`;

        const posts = profileUser.edge_owner_to_timeline_media?.edges || [];
        if (posts.length > 0) {
          output += `## Recent Posts\n\n`;
          for (const edge of posts.slice(0, 10)) {
            const node = edge.node;
            const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
            output += `- **Post**: ${caption.substring(0, 150)}...\n`;
            output += `  ❤️ ${formatNumber(node.edge_liked_by?.count)} likes | 💬 ${formatNumber(node.edge_media_to_comment?.count)} comments\n`;
            output += `  🔗 https://instagram.com/p/${node.shortcode}\n\n`;
          }
        }
        return output;
      }
    } catch (e) {
      // Continue
    }
  }

  return null;
}

// ─── XiaoHongShu ───

async function crawlXiaoHongShu(cookie, action, url, query, _maxResults) {
  const headers = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  let targetUrl = url;
  if (action === 'search' && query) {
    targetUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`;
  }

  if (!targetUrl) {
    return 'XiaoHongShu: specify action="read" with url, or action="search" with query.';
  }

  validateUrlForSSRF(targetUrl);
  const response = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    return `XiaoHongShu error: HTTP ${response.status} ${response.statusText}`;
  }

  const html = await response.text();
  return htmlToMarkdown(html, `XiaoHongShu - ${query || url}`);
}
