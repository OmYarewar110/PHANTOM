import { Router } from 'express';
import config, { updateConfig } from '../config.js';
import { resetClient, testConnection } from '../ai/llm-client.js';
import {
  createConversation, getConversations, getConversation, deleteConversation,
  updateConversationTitle, getMessages,
  getAllSettings, getSetting, setSetting,
  getAllMemories, searchMemories, hybridSearchMemories, getMemoryStats, saveMemory,
  getMCPServers, addMCPServer, removeMCPServer,
} from '../memory/store.js';
import { getToolDefinitions } from '../tools/registry.js';
import { validateUrlForSSRF, isWindowsAdmin } from '../tools/executor.js';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { rmSync, mkdirSync, existsSync, promises as fsPromises } from 'fs';

const execAsync = promisify(exec);
import { join, basename, resolve, sep } from 'path';
import multer from 'multer';
import { startBot, stopBot, getBotStatus } from '../telegram/bot.js';
import AdmZip from 'adm-zip';
import { marked } from 'marked';

const router = Router();

// Multer for file uploads (skills .zip)
const upload = multer({ dest: '/tmp/phantom-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Authentication Middleware ───
router.use((req, res, next) => {
  const token = process.env.API_TOKEN;
  if (!token) return next();

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  const provided = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : queryToken;

  if (!provided || provided !== token) {
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
      workspace: settings.workspace || config.workspace,
      sudoConfigured: isWindows ? true : !!settings.sudo_password,
      isWindows,
      windowsAdmin,
      telegramBotToken: settings.telegram_bot_token ? '••••••••' : '',
      telegramUserId: settings.telegram_user_id || '',
      systemPrompt: settings.system_prompt || config.systemPrompt || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', (req, res) => {
  try {
    const { baseUrl, apiKey, model, temperature, maxTokens, sudoPassword, workspace, telegramBotToken, telegramUserId, systemPrompt } = req.body;

    if (baseUrl) { setSetting('api_base_url', baseUrl); updateConfig({ baseUrl }); }
    if (apiKey && apiKey !== '••••••••') { setSetting('api_key', apiKey); updateConfig({ apiKey }); }
    if (model) { setSetting('api_model', model); updateConfig({ model }); }
    if (temperature !== undefined) { setSetting('api_temperature', String(temperature)); updateConfig({ temperature }); }
    if (maxTokens !== undefined) { setSetting('api_max_tokens', String(maxTokens)); updateConfig({ maxTokens }); }
    if (sudoPassword !== undefined) { setSetting('sudo_password', sudoPassword); }
    if (workspace) { setSetting('workspace', workspace); updateConfig({ workspace }); }
    if (telegramBotToken !== undefined && telegramBotToken !== '••••••••') { setSetting('telegram_bot_token', telegramBotToken); updateConfig({ telegramBotToken }); }
    if (telegramUserId !== undefined) { setSetting('telegram_user_id', telegramUserId); updateConfig({ telegramUserId }); }
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




// ─── Telegram ───
router.get('/telegram/status', (req, res) => {
  try {
    res.json(getBotStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/telegram/restart', (req, res) => {
  try {
    stopBot();
    startBot();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Agent Reach Config ───
const AR_PLATFORMS = ['twitter', 'reddit', 'xiaohongshu', 'linkedin', 'instagram'];

router.get('/agent-reach/config', (req, res) => {
  try {
    const result = {};
    for (const p of AR_PLATFORMS) {
      const cookie = getSetting(`ar_cookie_${p}`);
      result[p] = { configured: !!cookie };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/agent-reach/config', (req, res) => {
  try {
    const { platform, cookie } = req.body;
    if (!platform || !AR_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: `Invalid platform. Must be one of: ${AR_PLATFORMS.join(', ')}` });
    }
    setSetting(`ar_cookie_${platform}`, cookie || '');
    res.json({ success: true, message: `${platform} cookie saved` });
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
    const convs = getConversations().filter(c => !c.title || !c.title.toLowerCase().includes('telegram'));
    res.json(convs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations', (req, res) => {
  try {
    let title = req.body.title;
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Title must be a non-empty string' });
      }
      if (title.length > 200) {
        return res.status(400).json({ error: 'Title cannot exceed 200 characters' });
      }
    }
    const conv = createConversation(title || 'New Conversation');
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
    const title = req.body.title;
    if (typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title must be a non-empty string' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'Title cannot exceed 200 characters' });
    }
    updateConversationTitle(req.params.id, title);
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
router.get('/mcp/servers', (req, res) => {
  try {
    res.json(getMCPServers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/mcp/servers', (req, res) => {
  try {
    const id = addMCPServer(req.body);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/mcp/servers/:id', (req, res) => {
  try {
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
  if (typeof password !== 'string') {
    return res.json({ valid: false, message: 'Invalid password format' });
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
    console.error('[API] Sudo validation error'); // Don't log err.message which may contain password
    res.json({ valid: false, message: 'Validation error occurred' }); // Don't leak plain-text err.message
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


// ─── AI Doctor ───
// Uses temporary API credentials — completely separate from main PHANTOM config.
// Uses raw fetch to call any OpenAI-compatible API and pipes the SSE stream to the client.
router.post('/doctor/chat', async (req, res) => {
  const { message, config: doctorCfg, systemPrompt } = req.body;

  if (!doctorCfg?.apiKey) {
    return res.status(400).json({ error: 'API key required' });
  }

  const baseUrl = (doctorCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

  try {
    validateUrlForSSRF(baseUrl);
  } catch (err) {
    if (err.message === 'Invalid URL format' || err.message.includes('protocol')) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(403).json({ error: err.message });
  }

  const apiKey  = doctorCfg.apiKey;
  const model   = doctorCfg.model || 'gpt-4o';

  // Gather live system context without blocking the event loop
  const sysInfo = [];
  const sysCommands = [
    { prefix: 'OS: ', cmd: "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'" },
    { prefix: 'Kernel: ', cmd: 'uname -r' },
    { prefix: 'Uptime: ', cmd: 'uptime -p' },
    { prefix: 'Disk: ', cmd: 'df -h / | tail -1' },
    { prefix: 'Memory: ', cmd: 'free -h | head -2 | tail -1' },
    { prefix: 'Failed services:\n', cmd: 'systemctl --failed --no-legend 2>/dev/null | head -10' }
  ];

  const sysResults = await Promise.allSettled(
    sysCommands.map(c => execAsync(c.cmd, { encoding: 'utf8' }))
  );

  sysResults.forEach((result, idx) => {
    if (result.status === 'fulfilled' && result.value.stdout) {
      const output = result.value.stdout.trim();
      if (output) {
        sysInfo.push(sysCommands[idx].prefix + output);
      }
    }
  });

  const fullSystemPrompt =
    (systemPrompt || 'You are Dr. AI — an expert Linux system administrator and diagnostics AI. Diagnose and fix system issues proactively.') +
    (sysInfo.length ? `\n\n## LIVE SYSTEM STATE\n${sysInfo.join('\n')}` : '');

  const messages = [
    { role: 'system', content: fullSystemPrompt },
    { role: 'user',   content: message },
  ];

  // Send SSE headers immediately
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    // Call OpenAI-compatible API directly via fetch — no SDK, no dynamic import issues
    const apiRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      const errContent = `\n\n❌ **API Error ${apiRes.status}**\n\`\`\`\n${errText.substring(0, 400)}\n\`\`\``;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: errContent } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Pipe SSE bytes directly from OpenAI API → client (format is already correct)
    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done || req.socket.destroyed) break;
      res.write(decoder.decode(value, { stream: true }));
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('[AI Doctor] Error:', err.message);
    const errContent = `\n\n❌ **Error:** ${err.message}`;
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: errContent } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

export default router;
