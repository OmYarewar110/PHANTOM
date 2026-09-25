import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { dirname, resolve, join, sep, delimiter } from 'path';
import os from 'os';
import { saveMemory, hybridSearchMemories, getMemoryStats, searchConversations, createConversation } from '../memory/store.js';
import { getSetting } from '../memory/store.js';
import config from '../config.js';
import { getSystemCapabilities } from './self_awareness.js';
import { jinaReadUrl, youtubeSearch, youtubeGetSubtitles, rssReadFeed, v2exBrowse, socialMediaCrawl } from './internet.js';

/**
 * Checks if the current process is running with Windows Administrator (Elevated) privileges.
 */
export function isWindowsAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to securely escape arguments for bash shell
 */
function escapeShellArg(arg) {
  if (arg === undefined || arg === null) return "''";
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/**
 * Validates URLs to prevent SSRF vulnerabilities by ensuring they use allowed protocols
 * and do not point to internal or forbidden hostnames.
 */
export function validateUrlForSSRF(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (err) {
    throw new Error('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Invalid URL protocol. Only http and https are allowed.');
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Exact matches
  const forbiddenHosts = ['localhost', '127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', '[0:0:0:0:0:0:0:1]'];
  if (forbiddenHosts.includes(hostname)) {
    throw new Error('Access to internal/local hostnames is forbidden (SSRF protection).');
  }

  // IPv4 Loopback and ANY
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '0.0.0.0') {
    throw new Error('Access to loopback/ANY addresses is forbidden (SSRF protection).');
  }

  // AWS Metadata
  if (/^169\.254\.169\.254$/.test(hostname)) {
    throw new Error('Access to cloud metadata is forbidden (SSRF protection).');
  }

  // IPv6 Loopback
  if (/^\[?::1\]?$/.test(hostname) || /^\[?0:0:0:0:0:0:0:1\]?$/.test(hostname)) {
    throw new Error('Access to IPv6 loopback is forbidden (SSRF protection).');
  }

  // Localhost aliases and dynamic DNS services
  if (
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.nip.io') ||
    hostname.endsWith('.xip.io') ||
    hostname.endsWith('.sslip.io')
  ) {
    throw new Error('Access to dynamic DNS loopbacks/local domains is forbidden (SSRF protection).');
  }

  return parsedUrl;
}

/**
 * Execute a tool by name with given arguments
 * @param {Function} onProgress - optional callback for live output streaming
 */
export async function executeTool(name, args, onProgress) {
  switch (name) {
    case 'execute_command': return await executeCommand(args, onProgress);
    case 'read_file': return await readFileContent(args);
    case 'write_file': return await writeFileContent(args);
    case 'install_tool': return await installTool(args);
    case 'web_request': return await webRequest(args);
    case 'search_web': return await searchWeb(args);
    case 'scrape_webpage': return await scrapeWebpage(args);
    case 'save_memory': return await saveMemoryTool(args);
    case 'recall_memory': return await recallMemoryTool(args);
    case 'get_memory_stats': return getMemoryStatsTool();
    case 'search_conversations': return searchConversationsTool(args);
    case 'delegate_task': return await delegateTaskTool(args, onProgress);
    case 'list_directory': return await listDirectory(args);
    case 'python_execute': return await pythonExecute(args);
    case 'edit_source_code': return await editSourceCode(args);
    case 'save_trace': return await saveTrace(args);
    case 'scrapling_fetch': return await scraplingFetch(args, onProgress);
    case 'show_preview_window': return showPreviewWindow(args);
    case 'show_code_demo': return showCodeDemo(args);
    case 'write_skill': return await writeSkill(args);
    case 'analyze_target_graph': return analyzeTargetGraph(args);
    case 'send_file_to_telegram': return await sendFileToTelegramTool(args);
    case 'get_system_capabilities': return await getSystemCapabilitiesTool();
    case 'ruflo_agent_swarm': return await rufloAgentSwarm(args, onProgress);
    // Internet Crawling Tools (Agent Reach Zero-Config)
    case 'jina_read_url': return await jinaReadUrl(args);
    case 'youtube_search': return await youtubeSearch(args);
    case 'youtube_get_subtitles': return await youtubeGetSubtitles(args);
    case 'rss_read_feed': return await rssReadFeed(args);
    case 'v2ex_browse': return await v2exBrowse(args);
    case 'social_media_crawl': return await socialMediaCrawl(normalizeSocialArgs(args, args?.platform || 'reddit'));
    case 'reddit_crawl': return await socialMediaCrawl(normalizeSocialArgs(args, 'reddit'));
    case 'linkedin_crawl': return await socialMediaCrawl(normalizeSocialArgs(args, 'linkedin'));
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * Normalizes tool parameters for social media crawl tools (handles raw strings, missing actions, etc.)
 */
function normalizeSocialArgs(args, platform) {
  if (!args) return { platform, action: 'search', query: 'trending' };

  if (typeof args === 'string') {
    return { platform, action: 'search', query: args };
  }

  let norm = typeof args === 'object' && args !== null ? { ...args, platform } : { platform };

  if (norm.query || norm.topic || norm.keyword) {
    if (!norm.query) norm.query = norm.topic || norm.keyword;
    if (!norm.action || norm.action === 'read') {
      norm.action = norm.url ? 'read' : 'search';
    }
  }

  if (norm.url && !norm.action) {
    norm.action = 'read';
  }

  if (!norm.action) {
    norm.action = norm.url ? 'read' : 'search';
  }

  return norm;
}

/**
 * Write a new skill dynamically
 */
async function writeSkill({ name, description, code, entry_point = 'script.py' }) {
  try {
    const skillsDir = join(config.workspace, 'skills', name);
    await mkdir(skillsDir, { recursive: true });

    // Write the main script
    await writeFile(join(skillsDir, entry_point), code, 'utf8');

    // Make script executable if it's sh or py
    try {
      execSync(`chmod +x ${escapeShellArg(join(skillsDir, entry_point))}`);
    } catch (err) {
      console.error(`[writeSkill] Error setting permissions for ${name}:`, err.message);
    }

    // Write the skill manifest
    const manifest = {
      name,
      description,
      entry: entry_point
    };
    await writeFile(join(skillsDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf8');

    return `Skill "${name}" created successfully at ${skillsDir}.`;
  } catch (err) {
    return `Error creating skill: ${err.message}`;
  }
}

/**
 * Handle show_preview_window execution.
 * Returns a JSON payload so the frontend can intercept and render the HTML.
 */
function showPreviewWindow({ html_content, title, open_new_window }) {
  if (!html_content) {
    throw new Error('html_content is required to show preview window.');
  }
  return JSON.stringify({
    success: true,
    message: `Successfully rendered preview window: "${title || 'Preview'}"`,
    html_content: html_content,
    title: title || 'Preview',
    open_new_window: open_new_window !== undefined ? !!open_new_window : true
  });
}

/**
 * Handle show_code_demo execution.
 */
function showCodeDemo({ code, language, title }) {
  if (!code || !language) {
    throw new Error('code and language are required to show code demo.');
  }

  const escapedCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title || 'Code Demo'}</title>
  <style>
    body { font-family: sans-serif; background: #0d0d0d; color: #f3f4f6; padding: 20px; margin: 0; }
    pre { background: #1a1a1a; padding: 20px; border-radius: 8px; overflow-x: auto; }
    code { font-family: 'Courier New', Courier, monospace; }
  </style>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/${language}.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', (event) => {
      document.querySelectorAll('pre code').forEach((el) => {
        hljs.highlightElement(el);
      });
    });
  </script>
</head>
<body>
  <h2>${title || 'Code Demo'}</h2>
  <pre><code class="language-${language}">${escapedCode}</code></pre>
</body>
</html>
  `;

  return JSON.stringify({
    success: true,
    message: `Successfully rendered code demo: "${title || 'Code Demo'}"`,
    html_content: htmlContent,
    title: title || 'Code Demo',
    open_new_window: true
  });
}

/**
 * Handle analyze_target_graph execution.
 * Autonomously creates a visualization and delegates to showPreviewWindow to open it in a new window.
 */
function analyzeTargetGraph({ target_name, nodes, edges }) {
  if (!target_name || !nodes || !Array.isArray(nodes)) {
    throw new Error('target_name and nodes array are required.');
  }

  // Generate a basic Mermaid.js graph HTML payload
  const escapedTarget = target_name.replace(/"/g, '\\"');
  let mermaidNodes = `graph TD;\n  Target["${escapedTarget}"]`;

  // Create a map to securely reference nodes by ID
  const nodeMap = { [target_name]: 'Target' };

  nodes.forEach((node, index) => {
    const escapedNode = node.replace(/"/g, '\\"');
    const nodeId = `Node${index}`;
    nodeMap[node] = nodeId;
    mermaidNodes += `\n  ${nodeId}["${escapedNode}"]`;
  });

  if (edges && Array.isArray(edges) && edges.length > 0) {
    edges.forEach((edge) => {
      const sourceId = nodeMap[edge.source] || `Unknown${Math.floor(Math.random()*10000)}`;
      const targetId = nodeMap[edge.target] || `Unknown${Math.floor(Math.random()*10000)}`;
      if (edge.label) {
         mermaidNodes += `\n  ${sourceId} -- "${edge.label.replace(/"/g, '\\"')}" --> ${targetId}`;
      } else {
         mermaidNodes += `\n  ${sourceId} --> ${targetId}`;
      }
    });
  } else {
    // Fallback to simple star topology if no edges provided
    nodes.forEach((node, index) => {
      mermaidNodes += `\n  Target --> Node${index}`;
    });
  }

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Target Analysis: ${target_name}</title>
  <style>
    body { font-family: sans-serif; background: #0d0d0d; color: #f3f4f6; text-align: center; padding: 50px; }
    .graph-container { background: #1a1a1a; padding: 20px; border-radius: 8px; display: inline-block; margin-top: 20px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  </script>
</head>
<body>
  <h1>Analysis for ${target_name}</h1>
  <p>Interactive target topology generated autonomously.</p>
  <div class="graph-container">
    <div class="mermaid">
      ${mermaidNodes}
    </div>
  </div>
</body>
</html>
  `;

  // Reuse showPreviewWindow logic, forcing open_new_window to true
  return showPreviewWindow({
    html_content: htmlContent,
    title: `Graph: ${target_name}`,
    open_new_window: true
  });
}

// User agent rotation to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Execute a shell command with optional live output streaming
 */
async function executeCommand({ command, timeout = 120, working_directory, use_sudo = false }, onProgress) {
  return new Promise((resolvePromise) => {
    let cmd = command;
    const isWindows = process.platform === 'win32';

    if (isWindows && cmd.trim().startsWith('sudo ')) {
      cmd = cmd.trim().replace(/^sudo\s+/, '');
    }

    const needsSudo = !isWindows && (use_sudo || command.trim().startsWith('sudo '));
    if (needsSudo) {
      const sudoPass = getSetting('sudo_password', '');
      if (sudoPass) {
        const cleanCmd = command.trim().startsWith('sudo ') ? command.trim().replace(/^sudo\s+/, '') : command;
        const escaped = sudoPass.replace(/'/g, "'\\''");
        cmd = `echo '${escaped}' | sudo -S -p '' ${cleanCmd} 2>&1`;
      } else {
        cmd = command.trim().startsWith('sudo ') ? command : `sudo ${command}`;
      }
    }

    let cwd = working_directory || config.workspace;
    if (!cwd || !existsSync(cwd)) {
      cwd = os.homedir();
    }

    let shellCmd = 'bash';
    let shellArgs = ['-c', cmd];

    if (isWindows) {
      const paths = (process.env.PATH || '').split(delimiter);
      const hasBash = paths.some(p => existsSync(join(p, 'bash.exe')) || existsSync(join(p, 'bash')));
      if (hasBash && process.env.PHANTOM_USE_BASH === 'true') {
        shellCmd = 'bash';
        shellArgs = ['-c', cmd];
      } else {
        shellCmd = 'powershell.exe';
        shellArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd];
      }
    }

    const proc = spawn(shellCmd, shellArgs, {
      cwd,
      timeout: timeout * 1000,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (onProgress) onProgress(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString().replace(/\[sudo\] password for.*?:\s*/g, '');
      if (text.trim()) {
        stderr += text;
        if (onProgress) onProgress(text);
      }
    });

    proc.on('close', (code) => {
      let result = '';
      if (stdout) result += stdout;
      if (stderr) result += (result ? '\n' : '') + `[STDERR] ${stderr}`;
      if (code !== 0 && code !== null) result += `\n[EXIT CODE] ${code}`;
      resolvePromise(result || `Command completed with exit code ${code}`);
    });

    proc.on('error', (err) => {
      resolvePromise(`Error executing command: ${err.message}`);
    });

    setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        console.warn(`Failed to kill process: ${err.message}`);
      }
      resolvePromise(stdout + stderr + `\n[TIMEOUT] Command timed out after ${timeout}s`);
    }, timeout * 1000);
  });
}

/**
 * Read file contents
 */
async function readFileContent({ path, max_lines = 500 }) {
  try {
    const resolvedPath = resolve(path);
    const safeRoot = resolve(config.workspace);
    if (!resolvedPath.startsWith(safeRoot + sep) && resolvedPath !== safeRoot) {
      return `Error: Access denied. Path is outside the workspace (${safeRoot})`;
    }
    const content = await readFile(resolvedPath, 'utf8');
    const lines = content.split('\n');
    if (lines.length > max_lines) {
      return lines.slice(0, max_lines).join('\n') + `\n\n... [truncated at ${max_lines} lines, total ${lines.length} lines]`;
    }
    return content;
  } catch (err) {
    return `Error reading file: ${err.message}`;
  }
}

/**
 * Write file contents
 */
async function writeFileContent({ path: filePath, content, append = false }) {
  try {
    const resolvedPath = resolve(filePath);
    const safeRoot = resolve(config.workspace);
    if (!resolvedPath.startsWith(safeRoot + sep) && resolvedPath !== safeRoot) {
      return `Error: Access denied. Path is outside the workspace (${safeRoot})`;
    }
    await mkdir(dirname(resolvedPath), { recursive: true });
    if (append) {
      const existing = await readFile(resolvedPath, 'utf8').catch(() => '');
      await writeFile(resolvedPath, existing + content, 'utf8');
    } else {
      await writeFile(resolvedPath, content, 'utf8');
    }
    return `File written successfully: ${resolvedPath}`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

/**
 * Install a security tool
 */
async function installTool({ name, method = 'auto', source }) {
  // Detect package manager if auto
  if (method === 'auto') {
    method = detectPackageManager();
  }

  const sudoPass = getSetting('sudo_password', '');
  const sudoPrefix = sudoPass ? `echo '${sudoPass.replace(/'/g, "'\\''")}' | sudo -S` : 'sudo';

  let cmd;
  switch (method) {
    case 'apt':
      cmd = `${sudoPrefix} apt-get install -y ${name}`;
      break;
    case 'pacman':
      cmd = `${sudoPrefix} pacman -S --noconfirm ${name}`;
      break;
    case 'yum':
      cmd = `${sudoPrefix} yum install -y ${name}`;
      break;
    case 'pip':
      cmd = `pip install ${name}`;
      break;
    case 'pipx':
      cmd = `pipx install ${name}`;
      break;
    case 'go':
      cmd = `go install ${source || name}@latest`;
      break;
    case 'cargo':
      cmd = `cargo install ${name}`;
      break;
    case 'npm':
      cmd = `${sudoPrefix} npm install -g ${name}`;
      break;
    case 'git':
      const url = source || `https://github.com/${name}`;
      const repoName = name.split('/').pop();
      cmd = `cd /opt && ${sudoPrefix} git clone ${url} ${repoName} 2>/dev/null || echo "Already cloned"`;
      break;
    case 'snap':
      cmd = `${sudoPrefix} snap install ${name}`;
      break;
    default:
      return `Unknown installation method: ${method}`;
  }

  return await executeCommand({ command: cmd, timeout: 300 });
}

function detectPackageManager() {
  const paths = (process.env.PATH || '').split(path.delimiter);
  const findCmd = (cmd) => paths.some(p => existsSync(path.join(p, cmd)));

  if (findCmd('apt-get')) return 'apt';
  if (findCmd('pacman')) return 'pacman';
  if (findCmd('yum')) return 'yum';
  if (findCmd('dnf')) return 'yum';

  return 'apt'; // default
}

/**
 * Make HTTP requests — enhanced with larger response limits and UA rotation
 */
async function webRequest({ url, method = 'GET', headers = {}, body, follow_redirects = true }) {
  try {
    try {
      validateUrlForSSRF(url);
    } catch (err) {
      return `Request error: ${err.message}`;
    }
    const opts = {
      method,
      headers: { 'User-Agent': getRandomUA(), ...headers },
      redirect: follow_redirects ? 'follow' : 'manual',
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      opts.body = body;
    }

    const response = await fetch(url, opts);
    const status = response.status;
    const respHeaders = Object.fromEntries(response.headers.entries());
    const text = await response.text();

    let result = `HTTP ${status} ${response.statusText}\n`;
    result += `Headers: ${JSON.stringify(respHeaders, null, 2)}\n\n`;
    // Increased limit from 10KB to 50KB
    const maxLen = 50000;
    result += text.substring(0, maxLen);
    if (text.length > maxLen) result += `\n... [truncated, ${text.length} total chars]`;

    return result;
  } catch (err) {
    return `Request error: ${err.message}`;
  }
}

/**
 * Search the web using Exa Neural Search MCP, DuckDuckGo Lite, HTML, system curl, and Jina search fallbacks.
 * Dynamically grounded with current date, month, and year context for maximum temporal accuracy.
 */
async function searchWeb({ query }) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return 'Please provide a valid search query.';
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const currentDateISO = now.toISOString().split('T')[0];

  let effectiveQuery = query.trim();
  const hasSpecificYear = /\b(19|20)\d{2}\b/.test(effectiveQuery);
  const isTimeSensitive = /\b(latest|news|today|current|trending|recent|update|price|weather|events|now|2026|2025)\b/i.test(effectiveQuery);

  // If query is time-sensitive and doesn't specify a year, append current year for temporal grounding
  if (isTimeSensitive && !hasSpecificYear) {
    effectiveQuery += ` ${currentYear}`;
  }

  const encoded = encodeURIComponent(effectiveQuery);

  // Engine 1: Exa MCP Free Neural Search (Highest Quality Neural Search)
  try {
    const exaArgs = { query: effectiveQuery, numResults: 10 };
    if (isTimeSensitive) {
      exaArgs.startPublishedDate = `${currentYear - 1}-01-01`;
    }

    const exaRes = await fetch('https://mcp.exa.ai/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: exaArgs
        }
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (exaRes.ok) {
      const text = await exaRes.text();
      const dataMatch = text.match(/data:\s*({[\s\S]*})/);
      if (dataMatch) {
        const parsed = JSON.parse(dataMatch[1]);
        const content = parsed?.result?.content?.[0]?.text;
        if (content && content.trim()) {
          return `Search results for "${query}" (As of ${currentMonthYear}, ${currentDateISO}):\n\n${content.trim()}`;
        }
      }
    }
  } catch (err) {
    // Continue to Engine 2
  }

  const results = [];

  // Engine 2: DuckDuckGo Lite via fetch GET
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encoded}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const html = await res.text();
      const links = html.match(/<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
      const snippets = html.match(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi) || [];

      for (let i = 0; i < links.length; i++) {
        const hrefMatch = links[i].match(/href="([^"]*)"/i);
        const titleMatch = links[i].match(/>([\s\S]*?)<\/a>/i);
        const snippetText = snippets[i] ? snippets[i].replace(/<[^>]+>/g, '').trim() : '';

        if (hrefMatch && titleMatch) {
          let url = hrefMatch[1];
          const uddgMatch = url.match(/uddg=([^&]+)/);
          if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

          const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
          if (title && url && !url.includes('duckduckgo.com')) {
            results.push({ url, title, snippet: snippetText });
          }
        }
      }
    }
  } catch (err) {
    // Continue to Engine 2
  }

  // Engine 2: DuckDuckGo HTML via fetch GET
  if (results.length === 0) {
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (res.ok) {
        const html = await res.text();
        const matches = html.match(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi) || [];

        for (const m of matches) {
          const urlMatch = m.match(/href="([^"]*)"/i);
          const titleMatch = m.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
          const snippetMatch = m.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

          if (urlMatch && titleMatch) {
            let url = urlMatch[1];
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

            const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

            if (title && url && !url.includes('duckduckgo.com')) {
              results.push({ url, title, snippet });
            }
          }
        }
      }
    } catch (err) {
      // Continue to Engine 3
    }
  }

  // Engine 3: Curl System Fallback (bypasses Node HTTP/TLS constraints)
  if (results.length === 0) {
    try {
      const curlOut = await executeCommand({
        command: `curl -sL --max-time 15 "https://lite.duckduckgo.com/lite/?q=${encoded}" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"`,
        timeout: 18,
      });

      if (curlOut && typeof curlOut === 'string' && curlOut.includes('result-link')) {
        const links = curlOut.match(/<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) || [];
        const snippets = curlOut.match(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi) || [];

        for (let i = 0; i < links.length; i++) {
          const hrefMatch = links[i].match(/href="([^"]*)"/i);
          const titleMatch = links[i].match(/>([\s\S]*?)<\/a>/i);
          const snippetText = snippets[i] ? snippets[i].replace(/<[^>]+>/g, '').trim() : '';

          if (hrefMatch && titleMatch) {
            let url = hrefMatch[1];
            const uddgMatch = url.match(/uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

            const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
            if (title && url && !url.includes('duckduckgo.com')) {
              results.push({ url, title, snippet: snippetText });
            }
          }
        }
      }
    } catch (err) {
      // Continue to Engine 4
    }
  }

  // Engine 4: Jina Search API
  if (results.length === 0) {
    try {
      const jinaRes = await fetch(`https://s.jina.ai/${encoded}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PHANTOM/1.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (jinaRes.ok) {
        const jinaData = await jinaRes.json();
        const items = jinaData.data || [];
        for (const item of items) {
          if (item.title && item.url) {
            results.push({ url: item.url, title: item.title, snippet: item.description || item.content || '' });
          }
        }
      }
    } catch (err) {
      // Continue
    }
  }

  // Format Results
  if (results.length > 0) {
    let output = `Search results for "${query}":\n\n`;
    const unique = [];
    for (const r of results) {
      if (!unique.some(u => u.url === r.url)) {
        unique.push(r);
      }
    }

    for (const r of unique.slice(0, 10)) {
      output += `• **${r.title || 'No title'}**\n  ${r.url}\n`;
      if (r.snippet) output += `  ${r.snippet}\n`;
      output += '\n';
    }
    return output;
  }

  return `No search results found for "${query}". Try rephrasing your search query.`;
}

/**
 * Scrape a webpage and extract readable text content
 * Strips HTML tags, scripts, styles, and returns clean text
 */
async function scrapeWebpage({ url, max_length = 30000 }) {
  try {
    try {
      validateUrlForSSRF(url);
    } catch (err) {
      return `Request error: ${err.message}`;
    }
    const response = await fetch(url, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return `HTTP Error ${response.status}: ${response.statusText}`;
    }

    const contentType = response.headers.get('content-type') || '';
    const html = await response.text();

    // If it's not HTML, return raw text
    if (!contentType.includes('html')) {
      return html.substring(0, max_length);
    }

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'No title';

    // Remove script, style, nav, footer, header, and svg tags and their content
    let text = html.replace(/<(script|style|nav|footer|header|svg)[^>]*>[\s\S]*?<\/\1>/gi, '');

    // Convert common HTML elements to readable format
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

    // Special case for links to keep text and URL
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)');

    // Remove all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Replace HTML entities in one pass
    const entities = {
      'nbsp': ' ',
      'amp': '&',
      'lt': '<',
      'gt': '>',
      'quot': '"',
      '#39': "'"
    };
    text = text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m, p1) => entities[p1] || m);

    // Final cleanup
    text = text
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .replace(/[ \t]+/g, ' ') // Collapse spaces
      .trim();

    let result = `📄 **${title}**\n🔗 ${url}\n\n${text}`;

    if (result.length > max_length) {
      result = result.substring(0, max_length) + `\n\n... [truncated, ${result.length} total chars]`;
    }

    return result;
  } catch (err) {
    return `Scrape error: ${err.message}. Try using execute_command with curl or wget instead.`;
  }
}

/**
 * Save to persistent memory (AgentMemory Engine)
 */
async function saveMemoryTool({ category, key, value, importance = 3 }) {
  try {
    await saveMemory(category, key, value, {}, importance);
    return `Memory saved to AgentMemory Engine: [${category}] ${key} (Importance: ${importance}/5)`;
  } catch (err) {
    return `Error saving memory: ${err.message}`;
  }
}

/**
 * Recall from persistent memory via Hybrid RRF Search
 */
async function recallMemoryTool({ query, category }) {
  try {
    const results = await hybridSearchMemories(query, category, 10);
    if (results.length === 0) return 'No matching memories found.';
    return results.map(m => `[${m.category}] ${m.key}: ${m.value} (Importance: ${m.importance || 3}, Recalled: ${m.access_count || 1}x)`).join('\n');
  } catch (err) {
    return `Error searching memory: ${err.message}`;
  }
}

/**
 * Get AgentMemory statistics and breakdown
 */
function getMemoryStatsTool() {
  try {
    const stats = getMemoryStats();
    let output = `# 🧠 AgentMemory Engine Stats\n\n`;
    output += `- **Total Memories:** ${stats.total_memories}\n`;
    output += `- **Average Importance:** ${stats.average_importance}/5.00\n\n`;
    output += `### Breakdown by Category\n`;
    for (const [cat, count] of Object.entries(stats.categories)) {
      output += `- **${cat}:** ${count}\n`;
    }
    if (stats.top_accessed.length > 0) {
      output += `\n### Top Accessed Memories\n`;
      stats.top_accessed.forEach(m => {
        output += `- [${m.category}] \`${m.key}\` — accessed ${m.access_count} times\n`;
      });
    }
    return output;
  } catch (err) {
    return `Error retrieving memory stats: ${err.message}`;
  }
}

/**
 * List directory contents
 */
async function listDirectory({ path: dirPath, show_hidden = false }) {
  try {
    const resolvedPath = resolve(dirPath);
    const safeRoot = resolve(config.workspace);
    if (!resolvedPath.startsWith(safeRoot + sep) && resolvedPath !== safeRoot) {
      return `Error: Access denied. Path is outside the workspace (${safeRoot})`;
    }
    const entries = await readdir(resolvedPath, { withFileTypes: true });

    // ⚡ Bolt: Fetch file stats in parallel instead of sequentially
    // Reduces latency significantly when listing large directories
    const promises = entries.map(async (entry) => {
      if (!show_hidden && entry.name.startsWith('.')) return null;
      try {
        const fullPath = resolve(resolvedPath, entry.name);
        const stats = await stat(fullPath);
        const type = entry.isDirectory() ? 'DIR' : 'FILE';
        const size = entry.isFile() ? formatSize(stats.size) : '';
        return `${type.padEnd(5)} ${size.padStart(10)} ${entry.name}`;
      } catch {
        return `???   ${entry.name}`;
      }
    });

    const results = (await Promise.all(promises)).filter(Boolean);

    return `Contents of ${resolvedPath}:\n${results.join('\n')}`;
  } catch (err) {
    return `Error listing directory: ${err.message}`;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * Execute Python code
 */
async function pythonExecute({ code, timeout = 60 }) {
  return await executeCommand({
    command: `python3 -c ${escapeShellArg(code)}`,
    timeout,
  });
}

/**
 * Edit PHANTOM's own source code — for self-improvement
 */
async function editSourceCode({ file_path, content, description }) {
  try {
    const { writeFile: wf, readFile: rf } = await import('fs/promises');
    const resolvedPath = resolve(file_path);

    // Safety: only allow editing within the project directory
    const projectRoot = resolve(config.root);
    if (!resolvedPath.startsWith(projectRoot + sep) && resolvedPath !== projectRoot) {
      return `Error: Can only edit files within the project directory (${projectRoot})`;
    }

    // Backup original
    try {
      const original = await rf(resolvedPath, 'utf8');
      const backupDir = join(config.workspace, '.backups');
      const { mkdirSync } = await import('fs');
      try {
        mkdirSync(backupDir, { recursive: true });
      } catch (err) {
        console.warn(`[editSourceCode] Failed to create .backups dir:`, err.message);
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = resolvedPath.replace(/\//g, '_').slice(1);
      await wf(join(backupDir, `${backupName}.${timestamp}.bak`), original, 'utf8');
    } catch (err) {
      console.warn(`[editSourceCode] Failed to backup file:`, err.message);
    }

    await wf(resolvedPath, content, 'utf8');
    return `Source file edited: ${resolvedPath}\nDescription: ${description || 'No description'}\nNote: Restart may be needed for changes to take effect.`;
  } catch (err) {
    return `Error editing source: ${err.message}`;
  }
}

/**
 * Save execution trace for self-optimization (Meta-Harness pattern)
 */
async function saveTrace({ task, approach, outcome, score, notes }) {
  try {
    const { mkdirSync: mkd } = await import('fs');
    const { writeFile: wfp } = await import('fs/promises');
    const tracesDir = join(config.workspace, '.traces');
    try {
      mkd(tracesDir, { recursive: true });
    } catch (err) {
      console.warn(`[saveTrace] Failed to create .traces dir:`, err.message);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trace = {
      timestamp: new Date().toISOString(),
      task,
      approach,
      outcome,
      score: score || null,
      notes: notes || '',
    };

    await wfp(join(tracesDir, `trace-${timestamp}.json`), JSON.stringify(trace, null, 2), 'utf8');
    return `Trace saved: ${task} (outcome: ${outcome})`;
  } catch (err) {
    return `Error saving trace: ${err.message}`;
  }
}

/**
 * Scrapling-powered web fetching — bypasses anti-bot, renders JS, extracts data
 */
async function scraplingFetch({ url, mode = 'basic', css_selector, xpath, proxy, solve_cloudflare = true }, onProgress) {
  try {
    validateUrlForSSRF(url);
  } catch (err) {
    return `Request error: ${err.message}`;
  }
  const bridgePath = resolve(import.meta.dirname, 'scrapling_bridge.py');

  let cmd = `python3 ${escapeShellArg(bridgePath)} ${escapeShellArg(url)} --mode ${escapeShellArg(mode)}`;
  if (css_selector) cmd += ` --css ${escapeShellArg(css_selector)}`;
  if (xpath) cmd += ` --xpath ${escapeShellArg(xpath)}`;
  if (proxy) cmd += ` --proxy ${escapeShellArg(proxy)}`;
  if (!solve_cloudflare) cmd += ` --no-cloudflare`;

  return await executeCommand({ command: cmd, timeout: 60 }, onProgress);
}


/**
 * Search past conversations tool
 */
function searchConversationsTool({ query }) {
  try {
    const results = searchConversations(query);
    if (!results || results.length === 0) return 'No matching conversations found.';

    // Format the results nicely
    let output = `Found ${results.length} results for "${query}":\n\n`;
    for (const r of results) {
      output += `- [${r.conversation_title} | ${r.role}] ${r.created_at}\n  ${r.matched_text.substring(0, 150)}...\n\n`;
    }
    return output;
  } catch (error) {
    return `Error searching conversations: ${error.message}`;
  }
}

/**
 * Delegate task to a subagent
 */
async function delegateTaskTool({ task_description }, onProgress) {
  try {
    if (onProgress) onProgress(`Spawning subagent for task: ${task_description.substring(0, 50)}...`);

    // Dynamically import processMessage to avoid circular dependencies
    const { processMessage } = await import('../ai/llm-client.js');

    // Create an isolated conversation for the subagent
    const subConv = createConversation('Subagent: ' + task_description.substring(0, 30));

    // Define an abort signal (optional)
    const ac = new AbortController();

    // Run the subagent
    const result = await processMessage(
      subConv.id,
      task_description,
      null, // sessionContext
      () => {}, // ignore chunking for now
      (tc) => { if (onProgress) onProgress(`[Subagent] Using tool: ${tc.name}`); },
      () => {},
      (err) => { if (onProgress) onProgress(`[Subagent Error] ${err}`); },
      () => {},
      ac.signal,
      (tp) => { if (onProgress) onProgress(`[Subagent Tool] ${tp.name}: ${tp.text}`); }
    );

    return `Subagent completed task. Result:\n\n${result}`;
  } catch (error) {
    return `Error delegating task: ${error.message}`;
  }
}

async function getSystemCapabilitiesTool() {
  const skillsDir = join(config.workspace, 'skills');
  return getSystemCapabilities(skillsDir);
}


async function sendFileToTelegramTool({ file_path, caption = '' }) {
  // Get the active Telegram chat ID from the session
  const { getActiveTelegramSession } = await import('../telegram/session.js');
  const session = getActiveTelegramSession();

  if (!session || !session.chatId || !session.bot) {
    return { success: false, error: 'No active Telegram session. This tool only works when called from a Telegram chat.' };
  }

  const { sendFile } = await import('../telegram/sender.js');
  return await sendFile(session.bot, session.chatId, file_path, caption);
}

/**
 * Executes a multi-agent swarm via Ruflo.
 */
async function rufloAgentSwarm({ goal }, onProgress) {
  try {
    if (onProgress) onProgress('Initializing Ruflo multi-agent swarm...');

    // First run init to ensure config is set up
    await executeCommand({ command: 'npx claude-flow init --start-daemon --minimal', timeout: 120 }, onProgress);

    if (onProgress) onProgress(`Starting swarm with goal: ${goal}`);
    // Then start the swarm
    return await executeCommand({ command: `npx claude-flow swarm start -o "${goal}" -s balanced`, timeout: 600 }, onProgress);
  } catch (err) {
    return `Error executing Ruflo swarm: ${err.message}`;
  }
}
