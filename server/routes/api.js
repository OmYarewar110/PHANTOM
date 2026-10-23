import { Router } from 'express';
import config, { updateConfig } from '../config.js';
import { timingSafeEqual } from 'crypto';
import { resetClient, testConnection } from '../ai/llm-client.js';
import {
  createConversation, getConversations, getConversation, deleteConversation,
  updateConversationTitle, getMessages,
  getAllSettings, getSetting, setSetting,
  getAllMemories, searchMemories, hybridSearchMemories, getMemoryStats, saveMemory,
  getMCPServers, addMCPServer, removeMCPServer,
} from '../memory/store.js';
import { getToolDefinitions } from '../tools/registry.js';
import { isWindowsAdmin, executeCommand } from '../tools/executor.js';
import { reaCapabilities, reaListTools, reaCallTool } from '../tools/rea.js';
import { mcpClientHub } from '../mcp/client-hub.js';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { rmSync, mkdirSync, existsSync, promises as fsPromises } from 'fs';

const execAsync = promisify(exec);
import { join, basename, resolve, sep } from 'path';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { marked } from 'marked';

const router = Router();

// Multer for file uploads (skills .zip)
const upload = multer({ dest: '/tmp/phantom-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Authentication Middleware ───
router.use((req, res, next) => {
  const token = config.server.apiToken || process.env.API_TOKEN || '';
  const localOnly = ['127.0.0.1', '::1', 'localhost'].includes(config.server.host);
  if (!token && (process.env.PHANTOM_LOCAL_MODE === 'true' || (localOnly && process.env.NODE_ENV !== 'production'))) return next();
  if (!token) return res.status(503).json({ error: 'API_TOKEN must be configured for non-local or production use' });

  const authHeader = req.headers.authorization;
  const provided = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : '';

  const actual = Buffer.from(provided);
  const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API_TOKEN' });
  }
  next();
});

// ─── Settings ───
router.get('/settings', (req, res) => {
  try {
    const settings = getAllSettings();
    const isWindows = process.platform === 'win32';
    const windowsAdmin = isWindowsAdmin();
    res.json({
      baseUrl: settings.api_base_url || config.api.baseUrl,
      apiKey: settings.api_key ? '••••••••' + settings.api_key.slice(-4) : '',
      apiKeySet: !!settings.api_key || !!config.api.apiKey,
      model: settings.api_model || config.api.model,
      temperature: parseFloat(settings.api_temperature || config.api.temperature),
      maxTokens: parseInt(settings.api_max_tokens || config.api.maxTokens),
      autoMaxTokens: settings.api_auto_max_tokens === 'true',
      bypassCensorship: settings.bypass_censorship !== undefined ? settings.bypass_censorship === 'true' : (config.api.bypassCensorship ?? false),
      workspace: settings.workspace || config.workspace,
      sudoConfigured: isWindows ? true : !!settings.sudo_password,
      isWindows,
      windowsAdmin,
      systemPrompt: settings.system_prompt || config.systemPrompt || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', (req, res) => {
  try {
    const { baseUrl, apiKey, model, temperature, maxTokens, autoMaxTokens, bypassCensorship, sudoPassword, workspace, systemPrompt } = req.body;
    if (autoMaxTokens !== undefined && typeof autoMaxTokens !== 'boolean') {
      return res.status(400).json({ error: 'autoMaxTokens must be a boolean' });
    }
    if (bypassCensorship !== undefined && typeof bypassCensorship !== 'boolean') {
      return res.status(400).json({ error: 'bypassCensorship must be a boolean' });
    }

    if (baseUrl) { setSetting('api_base_url', baseUrl); updateConfig({ baseUrl }); }
    if (apiKey && !apiKey.startsWith('••')) { setSetting('api_key', apiKey); updateConfig({ apiKey }); }
    if (model) { setSetting('api_model', model); updateConfig({ model }); }
    if (temperature !== undefined) { setSetting('api_temperature', String(temperature)); updateConfig({ temperature }); }
    if (maxTokens !== undefined) { setSetting('api_max_tokens', String(maxTokens)); updateConfig({ maxTokens }); }
    if (autoMaxTokens !== undefined) setSetting('api_auto_max_tokens', autoMaxTokens);
    if (bypassCensorship !== undefined) {
      setSetting('bypass_censorship', String(bypassCensorship));
      updateConfig({ bypassCensorship });
    }
    if (sudoPassword !== undefined) { setSetting('sudo_password', sudoPassword); }
    if (workspace) { setSetting('workspace', workspace); updateConfig({ workspace }); }
    if (systemPrompt !== undefined) { setSetting('system_prompt', systemPrompt); updateConfig({ systemPrompt }); }

    resetClient();
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/test', async (req, res) => {
  try {
    const result = await testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// ─── AgentMemory Engine Endpoints ───
router.get('/memory/stats', (req, res) => {
  try {
    const stats = getMemoryStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/memory/search', async (req, res) => {
  try {
    const { q = '', category = null, limit = 10 } = req.query;
    const results = await hybridSearchMemories(q, category || null, parseInt(limit, 10) || 10);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/memory', async (req, res) => {
  try {
    const { category, key, value, importance = 3, metadata = {} } = req.body;
    if (!category || !key || !value) {
      return res.status(400).json({ error: 'category, key, and value are required' });
    }
    const id = await saveMemory(category, key, value, metadata, importance);
    res.json({ success: true, id, message: `Memory [${category}] ${key} saved to AgentMemory` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Conversations ───
router.get('/conversations', (req, res) => {
  try {
    res.json(getConversations());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations', (req, res) => {
  try {
    const conv = createConversation(req.body.title || 'New Conversation');
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id', (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const messages = getMessages(req.params.id);
    res.json({ ...conv, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/conversations/:id', (req, res) => {
  try {
    deleteConversation(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/conversations/:id/title', (req, res) => {
  try {
    updateConversationTitle(req.params.id, req.body.title);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id/export', (req, res) => {
  try {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const messages = getMessages(req.params.id);

    let markdown = `# ${conv.title}\n\n`;
    markdown += `*Exported on ${new Date().toLocaleString()}*\n\n---\n\n`;

    messages.forEach(msg => {
      if (msg.role === 'user') {
        markdown += `## 👤 User\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        if (msg.content) {
          markdown += `## 👻 PHANTOM\n\n${msg.content}\n\n`;
        }
        if (msg.tool_calls) {
          try {
            const calls = typeof msg.tool_calls === 'string' ? JSON.parse(msg.tool_calls) : msg.tool_calls;
            calls.forEach(c => {
              const argsStr = typeof c.args === 'object' ? JSON.stringify(c.args, null, 2) : c.args;
              markdown += `> **🔧 Tool Call:** \`${c.name}\`\n> \`\`\`json\n> ${argsStr.replace(/\n/g, '\n> ')}\n> \`\`\`\n\n`;
            });
          } catch {
            // Ignore parsing errors for malformed tool_calls
          }
        }
      } else if (msg.role === 'tool') {
        let contentStr = msg.content;
        if (typeof msg.content === 'object') {
          contentStr = JSON.stringify(msg.content, null, 2);
        }
        markdown += `<details><summary><b>📋 Tool Result: ${msg.name}</b></summary>\n\n\`\`\`\n${contentStr}\n\`\`\`\n</details>\n\n`;
      }
    });

    if (req.query.format === 'html') {
      const escapeHtml = (str) => {
        if (!str) return '';
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
        return str.replace(/[&<>"]/g, m => map[m]);
      };

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(conv.title)} - PHANTOM Export</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #22c55e; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
    h2 { margin-top: 1.5em; color: #111; }
    pre { background-color: #f6f8fa; padding: 16px; overflow: auto; border-radius: 6px; }
    code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 85%; }
    blockquote { padding: 0 1em; color: #6a737d; border-left: 0.25em solid #dfe2e5; margin: 0; }
    details { margin-bottom: 1em; padding: 0.5em; border: 1px solid #dfe2e5; border-radius: 6px; }
    summary { font-weight: bold; cursor: pointer; }
    .date { color: #6a737d; font-style: italic; }
  </style>
</head>
<body>
${marked.parse(markdown)}
</body>
</html>`;
      res.setHeader('Content-disposition', `attachment; filename=phantom_export_${conv.id.substring(0, 8)}.html`);
      res.setHeader('Content-type', 'text/html; charset=utf-8');
      res.send(htmlContent);
    } else {
      res.setHeader('Content-disposition', `attachment; filename=phantom_export_${conv.id.substring(0, 8)}.md`);
      res.setHeader('Content-type', 'text/markdown; charset=utf-8');
      res.send(markdown);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tools ───
router.get('/tools', (req, res) => {
  try {
    res.json(getToolDefinitions().map(t => ({
      name: t.function.name,
      description: t.function.description,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Memory ───
router.get('/memory', (req, res) => {
  try {
    const { query, category } = req.query;
    if (query) {
      res.json(searchMemories(query, category));
    } else {
      res.json(getAllMemories(category));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MCP Servers ───
router.get('/mcp/servers', async (req, res) => {
  try {
    const servers = await mcpClientHub.listServers();
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mcp/servers', async (req, res) => {
  try {
    const result = await mcpClientHub.configureServer(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/mcp/servers/:id', async (req, res) => {
  try {
    await mcpClientHub.disconnectServer(req.params.id);
    removeMCPServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sudo Validation ───
router.post('/sudo/validate', async (req, res) => {
  if (process.platform === 'win32') {
    const isAdmin = isWindowsAdmin();
    return res.json({
      valid: true,
      isWindows: true,
      isElevated: isAdmin,
      message: isAdmin ? 'Running in Windows Administrative mode 🛡️' : 'Running in Windows Normal User mode 💻'
    });
  }

  const { password } = req.body;
  if (!password) {
    return res.json({ valid: false, message: 'No password provided' });
  }

  try {
    // Test sudo password by running a harmless command without blocking event loop
    const escapedPass = password.replace(/'/g, "'\\''");
    try {
      await execAsync(`echo '${escapedPass}' | sudo -S -p '' echo 'phantom_sudo_ok' 2>&1`, {
        encoding: 'utf8',
        timeout: 15000,
      });
      // Password is correct — store it
      setSetting('sudo_password', password);
      res.json({ valid: true, message: 'Sudo access granted ✅' });
    } catch {
      res.json({ valid: false, message: 'Incorrect sudo password' });
    }
  } catch (err) {
    res.json({ valid: false, message: `Validation error: ${err.message}` });
  }
});

router.get('/sudo/status', (req, res) => {
  const isWindows = process.platform === 'win32';
  const isAdmin = isWindowsAdmin();
  const sudoPassword = getSetting('sudo_password', '');
  res.json({
    isWindows,
    isElevated: isWindows ? isAdmin : !!sudoPassword,
    sudoConfigured: isWindows ? isAdmin : !!sudoPassword,
    message: isWindows
      ? (isAdmin ? 'Running in Windows Administrative mode 🛡️' : 'Running in Windows Normal User mode 💻')
      : (sudoPassword ? 'Sudo password configured and verified ✅' : 'No sudo password configured ⚠️')
  });
});

router.post('/system/elevate-windows', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.json({ success: false, message: 'Elevation helper is for Windows only.' });
  }
  try {
    if (isWindowsAdmin()) {
      return res.json({ success: true, isElevated: true, message: 'Already running as Administrator 🛡️' });
    }
    // Launch PowerShell elevation prompt once
    await execAsync('powershell -Command "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden"', { timeout: 15000 });
    const nowAdmin = isWindowsAdmin();
    return res.json({
      success: true,
      isElevated: nowAdmin,
      message: nowAdmin ? 'Administrator privilege granted 🛡️' : 'Elevation prompt dismissed or denied.'
    });
  } catch (err) {
    return res.json({ success: false, message: `Elevation error: ${err.message}` });
  }
});


// ─── System Update ───
router.get('/system/check-update', async (req, res) => {
  try {
    // Fetch latest from origin to check if we are behind
    await execAsync('git fetch origin main', { encoding: 'utf8' });

    // Check if we are behind origin/main
    const statusCmd = await execAsync('git rev-list HEAD...origin/main --count', { encoding: 'utf8' });
    const commitsBehind = parseInt(statusCmd.stdout.trim(), 10);

    const updateAvailable = commitsBehind > 0;

    // Get latest commit message
    let message = '';
    if (updateAvailable) {
        const logCmd = await execAsync('git log -1 --pretty=%B origin/main', { encoding: 'utf8' });
        message = logCmd.stdout.trim();
    }

    res.json({
      updateAvailable,
      commitsBehind,
      message
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/system/update', async (req, res) => {
  // Use SSE to send progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (msg) => {
    res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  };

  try {
    sendProgress('Fetching latest updates from GitHub...');
    await execAsync('git fetch origin main', { encoding: 'utf8' });
    sendProgress('Resetting to latest changes...');
    const pullResult = await execAsync('git reset --hard origin/main', { encoding: 'utf8' });
    sendProgress(pullResult.stdout);

    sendProgress('Installing dependencies...');
    const npmResult = await execAsync('npm install', { encoding: 'utf8' });
    sendProgress(npmResult.stdout);

    sendProgress('Update complete! Auto-restarting system...');
    res.write('data: [DONE]\n\n');
    res.end();

    // Give time for the SSE connection to finish, then trigger auto-restart (exit code 42)
    setTimeout(() => {
      console.log('[PHANTOM] Auto-restarting server after update...');
      process.exit(42);
    }, 1500);
  } catch (err) {
    console.error('Update error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ─── System Info ───
let cachedSystemInfo = null;

router.get('/system/info', async (req, res) => {
  try {
    if (!cachedSystemInfo) {
      cachedSystemInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        user: os.userInfo().username,
        cpus: os.cpus().length,
      };

      // Run external commands concurrently without blocking the event loop
      const results = await Promise.allSettled([
        execAsync('cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\'', { encoding: 'utf8' }),
        execAsync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf8' })
      ]);

      if (results[0].status === 'fulfilled' && results[0].value.stdout) {
        cachedSystemInfo.distro = results[0].value.stdout.trim();
      }
      if (results[1].status === 'fulfilled' && results[1].value.stdout) {
        cachedSystemInfo.ip = results[1].value.stdout.trim();
      }
    }

    const info = {
      ...cachedSystemInfo,
      uptime: os.uptime(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
      },
    };

    info.isWindows = process.platform === 'win32';
    info.windowsAdmin = isWindowsAdmin();
    info.sudoConfigured = process.platform === 'win32' ? true : !!getSetting('sudo_password', '');
    info.workspace = config.workspace;

    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Workspace File Explorer ───
router.get('/workspace/files', async (req, res) => {
  try {
    const rootDir = config.workspace;
    if (!existsSync(rootDir)) {
      mkdirSync(rootDir, { recursive: true });
    }

    async function scanDirectory(dirPath, relativeDir = '') {
      const items = [];
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const relPath = relativeDir ? join(relativeDir, entry.name) : entry.name;
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const children = await scanDirectory(fullPath, relPath);
          items.push({
            name: entry.name,
            path: relPath,
            isDirectory: true,
            children
          });
        } else {
          const stats = await fsPromises.stat(fullPath);
          items.push({
            name: entry.name,
            path: relPath,
            isDirectory: false,
            size: stats.size,
            mtime: stats.mtime
          });
        }
      }
      items.sort((a, b) => (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0) || a.name.localeCompare(b.name));
      return items;
    }

    const tree = await scanDirectory(rootDir);
    res.json({ success: true, workspace: config.workspace, tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/workspace/file', async (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) return res.status(400).json({ error: 'Missing path parameter' });
    const fullPath = resolve(config.workspace, relPath);
    if (!fullPath.startsWith(config.workspace + sep) && fullPath !== config.workspace) {
      return res.status(403).json({ error: 'Access denied: outside workspace' });
    }
    const content = await fsPromises.readFile(fullPath, 'utf8');
    res.json({ success: true, path: relPath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Skills Management ───
function getSkillsDir() {
  const dir = join(config.workspace, 'skills');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

router.get('/skills', async (req, res) => {
  try {
    const skillsDir = getSkillsDir();
    const entries = await fsPromises.readdir(skillsDir, { withFileTypes: true });

    const skillPromises = entries.filter(e => e.isDirectory()).map(async (e) => {
      const skillPath = join(skillsDir, e.name);
      let meta = { name: e.name, description: '', files: [] };
      // Try reading a manifest
      try {
        const metaPath = join(skillPath, 'skill.json');
        try {
          const content = await fsPromises.readFile(metaPath, 'utf8');
          meta = { ...meta, ...JSON.parse(content) };
        } catch (err) {
           if (err.code !== 'ENOENT') throw err;
        }
      } catch (err) {
        console.warn(`[Skills] Failed to read skill.json for ${e.name}:`, err.message);
      }
      try {
        const files = await fsPromises.readdir(skillPath);
        meta.files = files.slice(0, 20);
      } catch (err) {
        console.warn(`[Skills] Failed to read files for ${e.name}:`, err.message);
      }
      return meta;
    });

    const skills = await Promise.all(skillPromises);
    res.json(skills);
  } catch (err) {
    console.error('[Skills] Failed to list skills:', err.message);
    res.json([]);
  }
});

router.post('/skills/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const skillsDir = getSkillsDir();
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();
    // Determine skill name from zip
    const firstDir = entries.find(e => e.isDirectory);
    let skillName = firstDir ? firstDir.entryName.split('/')[0] : req.file.originalname.replace(/\.zip$/i, '');

    // Sanitize skillName to prevent path traversal
    skillName = basename(skillName);
    if (!skillName || skillName === '.' || skillName === '..' || !/^[a-zA-Z0-9_-]+$/.test(skillName)) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }

    const extractTo = resolve(join(skillsDir, skillName));

    // Check for Zip Slip vulnerability
    for (const entry of entries) {
      const entryPath = resolve(extractTo, entry.entryName);
      if (!entryPath.startsWith(extractTo + sep)) {
        return res.status(400).json({ error: 'Malicious zip file detected: Invalid path' });
      }
    }

    // Reject link entries. A symlink inside the zip can point outside the
    // skill directory, and how extraction handles links is library-defined;
    // today a link entry followed by a file under it crashes extraction and
    // leaves a half-written skill directory behind.
    for (const entry of entries) {
      const mode = (entry.header?.attr ?? entry.attr ?? 0) >>> 16;
      if ((mode & 0o170000) === 0o120000) {
        return res.status(400).json({ error: 'Malicious zip file detected: Link entries are not allowed' });
      }
    }

    if (!existsSync(extractTo)) mkdirSync(extractTo, { recursive: true });
    zip.extractAllTo(extractTo, true);
    // Cleanup temp file
    try {
      rmSync(req.file.path);
    } catch (err) {
      console.warn(`[Skills] Failed to cleanup temp file ${req.file.path}:`, err.message);
    }
    res.json({ success: true, name: skillName, message: `Skill "${skillName}" imported successfully` });
  } catch (err) {
    res.status(500).json({ error: `Failed to import skill: ${err.message}` });
  }
});

router.delete('/skills/:name', (req, res) => {
  try {
    const skillsDir = getSkillsDir();
    const skillName = basename(req.params.name);
    if (!skillName || skillName === '.' || skillName === '..' || !/^[a-zA-Z0-9_-]+$/.test(skillName)) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }
    const skillPath = join(skillsDir, skillName);
    if (existsSync(skillPath)) {
      rmSync(skillPath, { recursive: true, force: true });
      res.json({ success: true, message: `Skill "${skillName}" deleted` });
    } else {
      res.status(404).json({ error: 'Skill not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Connected Tools & REA / MCP Security Integrations ───
// ─── Connected Tools & REA / MCP Security Integrations ───
const SECURITY_CONNECTORS = [
  {
    id: 'rea',
    name: 'REA (Reverse Engineer Anything)',
    description: 'Autonomous reverse-engineering MCP bridge with 200+ specialized binary & dynamic inspection tools.',
    type: 'mcp',
    binary: 'rea',
    pkg: 'rea-agents',
    installMethod: 'npm',
    category: 'reverse-engineering'
  },
  {
    id: 'adb',
    name: 'Android Debug Bridge (ADB) Phone Connector',
    description: 'Direct USB & WiFi connection bridge to Android phones and tablets for mobile security auditing and screen control.',
    type: 'binary',
    binary: 'adb',
    pkg: 'adb',
    installMethod: 'apt',
    category: 'mobile-phone'
  },
  {
    id: 'scrcpy',
    name: 'Scrcpy Phone Display & Control',
    description: 'Display and control Android devices connected via USB or TCP/IP on your screen with ultra low latency.',
    type: 'binary',
    binary: 'scrcpy',
    pkg: 'scrcpy',
    installMethod: 'apt',
    category: 'mobile-phone'
  },
  {
    id: 'frida',
    name: 'Frida Dynamic Mobile & Native Instrumentation',
    description: 'Dynamic code instrumentation toolkit to hook functions and inspect memory on Android, iOS, and desktop apps.',
    type: 'binary',
    binary: 'frida',
    pkg: 'frida-tools',
    installMethod: 'pip',
    category: 'mobile-phone'
  },
  {
    id: 'nmap',
    name: 'Nmap Network Scanner',
    description: 'Industry standard network discovery, vulnerability scanner, and port auditing tool.',
    type: 'binary',
    binary: 'nmap',
    pkg: 'nmap',
    installMethod: 'apt',
    category: 'network'
  },
  {
    id: 'metasploit',
    name: 'Metasploit Framework',
    description: 'World leading penetration testing and vulnerability validation platform with thousands of exploits.',
    type: 'binary',
    binary: 'msfconsole',
    pkg: 'metasploit-framework',
    installMethod: 'apt',
    category: 'exploitation'
  },
  {
    id: 'ghidra',
    name: 'Ghidra Software Reverse Engineering',
    description: 'NSA developed SRE framework for decompilation, disassembly, and binary analysis.',
    type: 'binary',
    binary: 'ghidra',
    pkg: 'ghidra',
    installMethod: 'apt',
    category: 'reverse-engineering'
  },
  {
    id: 'radare2',
    name: 'Radare2 / Rizin Binary Analysis',
    description: 'Advanced command-line hex editor, disassembler, and debugger framework.',
    type: 'binary',
    binary: 'r2',
    pkg: 'radare2',
    installMethod: 'apt',
    category: 'reverse-engineering'
  },
  {
    id: 'sqlmap',
    name: 'SQLMap Automatic SQL Injection',
    description: 'Automated tool to detect and exploit SQL injection flaws and take over database servers.',
    type: 'binary',
    binary: 'sqlmap',
    pkg: 'sqlmap',
    installMethod: 'apt',
    category: 'web-security'
  },
  {
    id: 'nuclei',
    name: 'Nuclei Fast Vulnerability Scanner',
    description: 'Community-powered template-based vulnerability scanner for apps and networks.',
    type: 'binary',
    binary: 'nuclei',
    pkg: 'projectdiscovery/nuclei/v3/cmd/nuclei@latest',
    installMethod: 'go',
    category: 'web-security'
  },
  {
    id: 'gobuster',
    name: 'Gobuster Directory & DNS Brute-Forcer',
    description: 'High-speed directory, DNS sub-domain, and virtual host enumeration scanner.',
    type: 'binary',
    binary: 'gobuster',
    pkg: 'gobuster',
    installMethod: 'apt',
    category: 'reconnaissance'
  },
  {
    id: 'nikto',
    name: 'Nikto Web Server Scanner',
    description: 'Comprehensive web server scanner for dangerous files, outdated server software, and CGIs.',
    type: 'binary',
    binary: 'nikto',
    pkg: 'nikto',
    installMethod: 'apt',
    category: 'web-security'
  },
  {
    id: 'tshark',
    name: 'Wireshark TShark Packet Analyzer',
    description: 'Command-line terminal network traffic analyzer and deep packet inspection engine.',
    type: 'binary',
    binary: 'tshark',
    pkg: 'tshark',
    installMethod: 'apt',
    category: 'network'
  },
  {
    id: 'hydra',
    name: 'THC-Hydra Network Logon Cracker',
    description: 'Very fast network authentication cracker supporting numerous protocols (SSH, FTP, HTTP, etc.).',
    type: 'binary',
    binary: 'hydra',
    pkg: 'hydra',
    installMethod: 'apt',
    category: 'credential-testing'
  }
];

router.get('/connected-tools', async (req, res) => {
  try {
    const customConnectors = JSON.parse(getSetting('custom_connectors', '[]') || '[]');
    const allConnectors = [...SECURITY_CONNECTORS, ...customConnectors];
    // Load manually activated / connected tool states from database
    const connectedState = JSON.parse(getSetting('connected_tools_state', '{}') || '{}');

    // Check availability in PATH or package
    const pathDirs = (process.env.PATH || '').split(sep === '\\' ? ';' : ':');
    const checked = await Promise.all(allConnectors.map(async (tool) => {

      let installed = false;
      let version = null;

      if (tool.id === 'rea') {
        const caps = reaCapabilities();
        installed = true;
        const isConnected = caps.toolCallsEnabled || connectedState['rea'] === true;
        return {
          ...tool,
          installed,
          connected: isConnected,
          version: caps.version,
          details: caps,
        };
      }

      // Check if binary is executable on PATH
      for (const dir of pathDirs) {
        const candidate = join(dir, tool.binary);
        if (existsSync(candidate)) {
          installed = true;
          break;
        }
      }

      // If user connected or tool is installed on PATH
      const isConnected = installed || connectedState[tool.id] === true;

      return {
        ...tool,
        installed,
        connected: isConnected,
        version,
      };
    }));

    res.json({ success: true, tools: checked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }

});

router.post('/connected-tools/connect', async (req, res) => {
  try {
    const { id, action = 'install' } = req.body;
    if (!id) return res.status(400).json({ error: 'Tool id is required' });

    if (id === 'rea') {
      // Toggle or enable REA tool calls
      process.env.REA_ENABLE_TOOL_CALLS = 'true';
      setSetting('rea_enabled', 'true');
      return res.json({ success: true, message: 'REA MCP tool bridge connected and active' });
    }

    const customConnectors = JSON.parse(getSetting('custom_connectors', '[]') || '[]');
    const target = [...SECURITY_CONNECTORS, ...customConnectors].find(t => t.id === id);
    if (!target) return res.status(404).json({ error: `Tool ${id} not found` });

    if (action === 'connect' || action === 'reactivate' || action === 'mark_active') {
      const connectedState = JSON.parse(getSetting('connected_tools_state', '{}') || '{}');
      connectedState[id] = true;
      setSetting('connected_tools_state', JSON.stringify(connectedState));
      return res.json({ success: true, message: `Tool ${target.name} activated and connected` });
    }

    if (action === 'install') {
      const connectedState = JSON.parse(getSetting('connected_tools_state', '{}') || '{}');
      connectedState[id] = true;
      setSetting('connected_tools_state', JSON.stringify(connectedState));

      const isLinux = process.platform === 'linux';
      let cmd = '';

      if (target.installMethod === 'apt' && isLinux) {
        cmd = `apt-get update && apt-get install -y ${target.pkg}`;
      } else if (target.installMethod === 'go') {
        cmd = `go install -v ${target.pkg}`;
      } else if (target.installMethod === 'pip') {
        cmd = `pip install --no-cache-dir ${target.pkg}`;
      } else if (target.installMethod === 'npm') {
        cmd = `npm install -g ${target.pkg}`;
      } else if (target.customCommand) {
        cmd = target.customCommand;
      } else {
        cmd = `which ${target.binary} || apt-get install -y ${target.binary}`;
      }

      const output = await executeCommand({ command: cmd, timeout: 300, use_sudo: isLinux });
      return res.json({ success: true, message: `Tool ${target.name} connected successfully`, output });
    }

    res.json({ success: true, message: `Tool ${target.name} status updated` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/connected-tools/custom', (req, res) => {
  try {
    const { name, binary, description, installMethod = 'apt', pkg, customCommand } = req.body;
    if (!name || !binary) {
      return res.status(400).json({ error: 'Name and binary command are required' });
    }

    const customConnectors = JSON.parse(getSetting('custom_connectors', '[]') || '[]');
    const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const newTool = {
      id,
      name,
      binary,
      description: description || `Custom tool: ${name}`,
      installMethod,
      pkg: pkg || binary,
      customCommand,
      isCustom: true,
    };

    customConnectors.push(newTool);
    setSetting('custom_connectors', JSON.stringify(customConnectors));
    res.json({ success: true, tool: newTool });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/connected-tools/custom/:id', (req, res) => {
  try {
    const customConnectors = JSON.parse(getSetting('custom_connectors', '[]') || '[]');
    const filtered = customConnectors.filter(t => t.id !== req.params.id);
    setSetting('custom_connectors', JSON.stringify(filtered));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
