import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir, readdir, stat, rename, unlink, realpath, rm } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join, sep, delimiter, basename, relative, isAbsolute } from 'path';
import os from 'os';
import { saveMemory, hybridSearchMemories, getMemoryStats, searchConversations, createConversation, getSetting, setSetting, getMCPServers, removeMCPServer } from '../memory/store.js';
import config from '../config.js';
import { getSystemCapabilities } from './self_awareness.js';
import { jinaReadUrl } from './internet.js';
import { reaCallTool, reaCapabilities, reaListTools } from './rea.js';
import { mcpClientHub } from '../mcp/client-hub.js';
import { loadSkillsMetadata, loadFullSkill, invalidateSkillsCache } from '../skills/loader.js';

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

function isWithin(root, candidate) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Resolve a file path relative to the configured workspace and reject both
 * lexical traversal and symlinked paths that leave the workspace. Absolute
 * paths remain supported for compatibility when they are already inside it.
 */
export async function resolveWorkspacePath(filePath, { forWrite = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A file path is required.');

  const configuredRoot = resolve(config.workspace);
  const candidate = resolve(configuredRoot, filePath);
  if (!isWithin(configuredRoot, candidate)) {
    throw new Error(`Access denied. Path is outside the workspace (${configuredRoot})`);
  }

  if (forWrite) await mkdir(configuredRoot, { recursive: true });

  const realRoot = await realpath(configuredRoot).catch(() => configuredRoot);
  const existingPath = await realpath(candidate).catch(async error => {
    if (error?.code !== 'ENOENT') throw error;
    if (!forWrite) throw error;

    // The target may not exist yet. Check the nearest existing parent so a
    // symlinked directory cannot redirect a new write outside the workspace.
    let parent = dirname(candidate);
    while (isWithin(configuredRoot, parent)) {
      try {
        return await realpath(parent);
      } catch (parentError) {
        if (parentError?.code !== 'ENOENT') throw parentError;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    return candidate;
  });

  if (!isWithin(realRoot, existingPath)) {
    throw new Error(`Access denied. Path is outside the workspace (${realRoot})`);
  }
  return candidate;
}

async function writeFileAtomically(filePath, content, encoding = 'utf8') {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { encoding, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function validateSkillPart(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid ${label}: use letters, numbers, dots, underscores, or hyphens only.`);
  }
  return value;
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
  const forbiddenHosts = ['localhost', '127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', '[0:0:0:0:0:0:0:1]', 'metadata.google.internal', 'metadata.google'];
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

  if (isBlockedIp(hostname)) {
    throw new Error('Access to private or reserved addresses is forbidden (SSRF protection).');
  }

  return parsedUrl;
}

/**
 * True when a hostname that is already an IP literal (dotted IPv4, IPv6, or
 * IPv4-mapped IPv6 in dotted or hex form) falls in a loopback, private,
 * link-local, CGNAT, multicast, or otherwise reserved range.
 */
export function isBlockedIp(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();

  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/) || h.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const [a, b] = dotted[1].split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Execute a tool by name with given arguments
 * @param {Function} onProgress - optional callback for live output streaming
 */
export async function executeTool(name, args, onProgress, executionContext) {
  switch (name) {
    case 'execute_command': return await executeCommand(args, onProgress);
    case 'read_file': return await readFileContent(args);
    case 'write_file': return await writeFileContent(args);
    case 'generate_pdf': return await generatePdf(args);
    case 'install_tool': return await installTool(args, onProgress);
    case 'web_request': return await webRequest(args);
    case 'search_web': return await searchWeb(args);
    case 'scrape_webpage': return await scrapeWebpage(args);
    case 'save_memory': return await saveMemoryTool(args);
    case 'recall_memory': return await recallMemoryTool(args);
    case 'get_memory_stats': return getMemoryStatsTool();
    case 'search_conversations': return searchConversationsTool(args);
    case 'delegate_task': return await delegateTaskTool(args, onProgress, executionContext);
    case 'list_directory': return await listDirectory(args);
    case 'python_execute': return await pythonExecute(args);
    case 'edit_source_code': return await editSourceCode(args);
    case 'save_trace': return await saveTrace(args);
    case 'scrapling_fetch': return await scraplingFetch(args, onProgress);
    case 'show_preview_window': return showPreviewWindow(args);
    case 'show_code_demo': return showCodeDemo(args);
    case 'write_skill': return await writeSkill(args);
    case 'analyze_target_graph': return analyzeTargetGraph(args);
    case 'get_system_capabilities': return await getSystemCapabilitiesTool();
    // Web research tools
    case 'jina_read_url': return await jinaReadUrl(args);
    case 'rea_capabilities': return JSON.stringify(reaCapabilities());
    case 'rea_list_tools': return JSON.stringify(await reaListTools(args));
    case 'rea_call_tool': return JSON.stringify(await reaCallTool(args));
    // Autonomous MCP & Skill Management
    case 'configure_mcp_server': return await configureMcpServerTool(args);
    case 'list_mcp_servers': return await listMcpServersTool();
    case 'remove_mcp_server': return await removeMcpServerTool(args);
    case 'call_mcp_tool': return await callMcpTool(args);
    case 'manage_skills': return await manageSkillsTool(args);
    case 'agent_browser': return await agentBrowserAction(args, onProgress);
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * Write a new skill dynamically
 */
async function writeSkill({ name, description, code, entry_point = 'script.py' }) {
  try {
    const skillName = validateSkillPart(name, 'skill name');
    const entryPoint = validateSkillPart(entry_point, 'entry point');
    if (typeof description !== 'string' || !description.trim()) throw new Error('Skill description is required.');
    if (typeof code !== 'string') throw new Error('Skill code is required.');

    const skillsDir = await resolveWorkspacePath(join('skills', skillName), { forWrite: true });
    await mkdir(skillsDir, { recursive: true });
    await resolveWorkspacePath(join('skills', skillName, entryPoint), { forWrite: true });

    // Write the main script
    await writeFileAtomically(join(skillsDir, entryPoint), code, 'utf8');

    // Make script executable if it's sh or py
    if (/\.(?:sh|py)$/i.test(entryPoint)) {
      try {
        execSync(`chmod +x ${escapeShellArg(join(skillsDir, entryPoint))}`);
      } catch (err) {
        console.error(`[writeSkill] Error setting permissions for ${skillName}:`, err.message);
      }
    }

    // Write the skill manifest
    const manifest = {
      name: skillName,
      description: description.trim(),
      entry: entryPoint,
    };
    await writeFileAtomically(join(skillsDir, 'skill.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // The skill loader discovers skills from SKILL.md frontmatter. Keep the
    // legacy JSON manifest too, but make the markdown file authoritative for
    // discovery and progressive loading.
    const yamlValue = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
    const language = /\.(?:js|mjs|cjs)$/i.test(entryPoint)
      ? 'javascript'
      : /\.py$/i.test(entryPoint) ? 'python' : /\.(?:sh|bash)$/i.test(entryPoint) ? 'bash' : 'text';
    const implementation = language === 'javascript'
      ? `\n## Implementation\n\n\`\`\`${language}\n${code.replace(/```/g, '~~~')}\n\`\`\`\n`
      : `\n## Implementation\n\nThe executable source is stored in \`${entryPoint}\` and is loaded from the skill directory.\n`;
    const skillMarkdown = `---\nname: "${yamlValue(skillName)}"\ndescription: "${yamlValue(description)}"\nentry: "${yamlValue(entryPoint)}"\ntrust_tier: 3\n---\n\n# ${skillName}\n\n${description.trim()}\n${implementation}`;
    await writeFileAtomically(join(skillsDir, 'SKILL.md'), skillMarkdown, 'utf8');

    return `Skill "${skillName}" created successfully at ${skillsDir}.`;
  } catch (err) {
    return `Error creating skill: ${err.message}`;
  }
}

async function configureMcpServerTool(args = {}) {
  try {
    const result = await mcpClientHub.configureServer(args);
    return JSON.stringify(result, null, 2);
  } catch (err) {
    return `Error configuring MCP server: ${err.message}`;
  }
}

async function listMcpServersTool() {
  try {
    const servers = await mcpClientHub.listServers();
    return JSON.stringify(servers, null, 2);
  } catch (err) {
    return `Error listing MCP servers: ${err.message}`;
  }
}

async function removeMcpServerTool(args = {}) {
  try {
    const target = args.name_or_id || args.id || args.name;
    if (!target) throw new Error('name_or_id is required');
    await mcpClientHub.disconnectServer(target);
    const stored = getMCPServers().find(s => s.id === target || s.name === target);
    if (stored) {
      removeMCPServer(stored.id);
    }
    return `MCP Server "${target}" removed and disconnected successfully.`;
  } catch (err) {
    return `Error removing MCP server: ${err.message}`;
  }
}

async function callMcpTool(args = {}) {
  try {
    const { server_name, tool_name, arguments: toolArgs = {} } = args;
    if (!server_name || !tool_name) throw new Error('server_name and tool_name are required.');
    const result = await mcpClientHub.callTool(server_name, tool_name, toolArgs);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return `Error calling MCP tool: ${err.message}`;
  }
}

async function manageSkillsTool(args = {}) {
  try {
    const action = String(args.action || 'list').toLowerCase();
    const skillsDir = join(config.workspace, 'skills');

    if (action === 'list') {
      const skills = loadSkillsMetadata();
      return JSON.stringify(skills, null, 2);
    }

    if (action === 'info') {
      if (!args.name) throw new Error('Skill name is required for info action.');
      const full = loadFullSkill(args.name);
      if (!full) return `Skill "${args.name}" not found.`;
      return JSON.stringify(full, null, 2);
    }

    if (action === 'delete') {
      if (!args.name) throw new Error('Skill name is required for delete action.');
      const safeName = validateSkillPart(args.name, 'skill name');
      const targetDir = join(skillsDir, safeName);
      if (existsSync(targetDir)) {
        await rm(targetDir, { recursive: true, force: true });
        return `Skill "${safeName}" removed successfully.`;
      }
      return `Skill "${safeName}" does not exist.`;
    }

    return `Unsupported action: ${action}`;
  } catch (err) {
    return `Error managing skills: ${err.message}`;
  }
}

function markdownToPlainText(markdown) {
  return String(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/^```[^\n]*\n/gm, '')
    .replace(/^```\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/[*_~`]/g, '')
    .trim();
}

function wrapPdfLine(line, width = 96) {
  const value = String(line || '');
  if (value.length <= width) return [value];
  const wrapped = [];
  let remaining = value;
  while (remaining.length > width) {
    let splitAt = remaining.lastIndexOf(' ', width);
    if (splitAt < 1) splitAt = width;
    wrapped.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  wrapped.push(remaining);
  return wrapped;
}

function escapePdfText(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, character => `\\${character}`);
}

function buildPdfBuffer(content, title) {
  const plainText = markdownToPlainText(content);
  const lines = [title || 'PHANTOM document', '', ...plainText.split('\n').flatMap(line => wrapPdfLine(line))];
  const linesPerPage = 46;
  const pages = [];
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }
  if (pages.length === 0) pages.push(['PHANTOM document']);

  const objects = new Map();
  const pageObjectNumbers = pages.map((_, index) => 4 + (index * 2));
  const contentObjectNumbers = pages.map((_, index) => 5 + (index * 2));
  const objectCount = 3 + (pages.length * 2);

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectNumbers.map(number => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((pageLines, pageIndex) => {
    const commands = ['BT', '72 750 Td'];
    pageLines.forEach((line, lineIndex) => {
      commands.push(lineIndex === 0 ? '/F1 16 Tf' : '/F1 10 Tf');
      if (lineIndex > 0) commands.push('0 -16 Td');
      commands.push(`(${escapePdfText(line)}) Tj`);
    });
    commands.push('ET');
    const stream = commands.join('\n') + '\n';
    objects.set(pageObjectNumbers[pageIndex], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectNumbers[pageIndex]} 0 R >>`);
    objects.set(contentObjectNumbers[pageIndex], `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`);
  });

  let output = Buffer.from('%PDF-1.4\n', 'ascii');
  const offsets = [0];
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets[objectNumber] = output.length;
    const body = Buffer.from(`${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`, 'ascii');
    output = Buffer.concat([output, body]);
  }

  const xrefOffset = output.length;
  const xref = [`xref\n0 ${objectCount + 1}`, '0000000000 65535 f '];
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    xref.push(`${String(offsets[objectNumber]).padStart(10, '0')} 00000 n `);
  }
  xref.push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>`, `startxref\n${xrefOffset}`, '%%EOF\n');
  return Buffer.concat([output, Buffer.from(`${xref.join('\n')}\n`, 'ascii')]);
}

async function generatePdf({ content, filename = 'phantom-document.pdf', output_path, title = 'PHANTOM document' } = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required and must not be empty.');
  const requestedPath = output_path || filename;
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new Error('filename or output_path is required.');
  const pdfPath = requestedPath.toLowerCase().endsWith('.pdf') ? requestedPath : `${requestedPath}.pdf`;
  const resolvedPath = await resolveWorkspacePath(pdfPath, { forWrite: true });

  await mkdir(dirname(resolvedPath), { recursive: true });
  await resolveWorkspacePath(pdfPath, { forWrite: true });
  const pdf = buildPdfBuffer(content, title);
  await writeFileAtomically(resolvedPath, pdf);

  return JSON.stringify({
    success: true,
    message: `PDF generated successfully: ${resolvedPath}`,
    artifact: {
      type: 'pdf',
      path: resolvedPath,
      relativePath: relative(resolve(config.workspace), resolvedPath),
      bytes: pdf.length,
    },
  });
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
export async function executeCommand({ command, timeout = 120, working_directory, use_sudo = false }, onProgress) {
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
        // Wrap command in bash -c so compound statements (&&, ||, ;) maintain elevated privileges
        const escapedCmd = cleanCmd.replace(/'/g, "'\\''");
        cmd = `echo '${escaped}' | sudo -S -p '' bash -c '${escapedCmd}' 2>&1`;
      } else {
        return resolvePromise('[SUDO_REQUIRED] This operation needs elevated privileges. Enter your sudo password in the security access prompt, then retry the operation.');
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

    const startTime = Date.now();
    let lastOutputTime = Date.now();
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      lastOutputTime = Date.now();
      const text = data.toString();
      stdout += text;
      if (onProgress) onProgress(text);
    });

    proc.stderr.on('data', (data) => {
      lastOutputTime = Date.now();
      const text = data.toString().replace(/\[sudo\] password for.*?:\s*/g, '');
      if (text.trim()) {
        stderr += text;
        if (onProgress) onProgress(text);
      }
    });

    let settled = false;
    let timeoutHandle;
    const heartbeatInterval = setInterval(() => {
      if (settled) {
        clearInterval(heartbeatInterval);
        return;
      }
      const idleSec = Math.round((Date.now() - lastOutputTime) / 1000);
      if (idleSec >= 8 && onProgress) {
        const totalElapsed = Math.round((Date.now() - startTime) / 1000);
        onProgress(`⏳ [PHANTOM] Still working... (process active, ${totalElapsed}s elapsed)\n`);
        lastOutputTime = Date.now();
      }
    }, 6000);

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatInterval);
      clearTimeout(timeoutHandle);
      resolvePromise(value);
    };

    timeoutHandle = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        console.warn(`Failed to kill process: ${err.message}`);
      }
      settle(stdout + stderr + `\n[TIMEOUT] Command timed out after ${timeout}s`);
    }, timeout * 1000);

    proc.on('close', (code) => {
      let result = '';
      if (stdout) result += stdout;
      if (stderr) result += (result ? '\n' : '') + `[STDERR] ${stderr}`;
      if (code !== 0 && code !== null) result += `\n[EXIT CODE] ${code}`;
      settle(result || `Command completed with exit code ${code}`);
    });
    proc.on('error', (err) => settle(`Error executing command: ${err.message}`));
  });
}

/**
 * Read file contents
 */
async function readFileContent({ path, max_lines = 500 }) {
  try {
    const resolvedPath = await resolveWorkspacePath(path);
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
    if (typeof content !== 'string') return 'Error writing file: content must be a string.';
    const resolvedPath = await resolveWorkspacePath(filePath, { forWrite: true });
    await mkdir(dirname(resolvedPath), { recursive: true });
    // Re-check after creating parents in case a path component was replaced
    // by a symlink between validation and the write.
    await resolveWorkspacePath(filePath, { forWrite: true });
    if (append) {
      const existing = await readFile(resolvedPath, 'utf8').catch(() => '');
      await writeFileAtomically(resolvedPath, existing + content, 'utf8');
    } else {
      await writeFileAtomically(resolvedPath, content, 'utf8');
    }
    return `File written successfully: ${resolvedPath}`;
  } catch (err) {
    return `Error writing file: ${err.message}`;
  }
}

/**
 * Install a security tool
 */
const INSTALL_METHODS = new Set([
  'auto', 'apt', 'dnf', 'yum', 'pacman', 'zypper', 'brew', 'winget',
  'port', 'choco', 'scoop', 'pip', 'pipx', 'go', 'cargo', 'npm', 'git', 'snap',
]);

/**
 * Detect only package managers that are actually present. Returning null is
 * important: silently falling back to apt made installs unpredictable and
 * produced confusing failures on macOS/Windows.
 */
export function detectPackageManager({ platform = process.platform, path = process.env.PATH || '' } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return null;
  const candidates = platform === 'win32'
    ? ['winget', 'choco', 'scoop']
    : platform === 'darwin'
      ? ['brew', 'port']
      : ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'snap'];

  for (const candidate of candidates) {
    if (isExecutableOnPath(candidate, path, platform)) {
      return candidate;
    }
  }
  return null;
}

function isExecutableOnPath(command, path, platform) {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return path.split(delimiter).some(directory => suffixes.some(suffix => existsSync(join(directory, `${command}${suffix}`))));
}

function validatePackageName(name, method) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Tool name is required.');
  const value = name.trim();
  if (value.length > 200 || value.startsWith('-') || /[\0\r\n\t;&|`$<>"'\\]/.test(value)) {
    throw new Error('Invalid tool name: use a package/repository identifier without shell characters or options.');
  }

  const patterns = {
    npm: /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[A-Za-z0-9*^~<>=.-]+)?$/,
    pip: /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:===?|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!<>=~,-]+$/,
    pipx: /^[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9.*+!-]+)?$/,
    go: /^[A-Za-z0-9][A-Za-z0-9._~/-]+@v?[A-Za-z0-9.+-]+$/,
    cargo: /^[A-Za-z0-9][A-Za-z0-9_-]*(?:@[A-Za-z0-9.+-]+)?$/,
    git: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
  };
  const pattern = patterns[method];
  if (pattern && !pattern.test(value)) {
    const requirement = method === 'go' ? 'a module and pinned @version' : method === 'git' ? 'an owner/repository name' : 'a valid package identifier';
    throw new Error(`Invalid ${method} tool name: expected ${requirement}.`);
  }
  if (!pattern && !/^[A-Za-z0-9][A-Za-z0-9+_.:@=~^/-]*$/.test(value)) {
    throw new Error('Invalid tool name: use a package identifier without shell characters.');
  }
  return value;
}

function validateSource(source, method) {
  if (source === undefined || source === null || source === '') return undefined;
  if (typeof source !== 'string' || source.length > 2048 || /[\0\r\n\t;&|`$<>"'\\]/.test(source)) {
    throw new Error('Invalid source: provide an HTTPS URL without credentials or shell characters.');
  }
  if (method !== 'git') {
    throw new Error(`source is only supported for git installs (received method "${method}").`);
  }
  let parsed;
  try {
    parsed = validateUrlForSSRF(source);
  } catch (error) {
    throw new Error(`Invalid git source: ${error.message}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Invalid git source: use an HTTPS URL without embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  const privateIpv4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host);
  if (privateIpv4 || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Invalid git source: private and local hosts are not allowed.');
  }
  return parsed.toString();
}

/** Build a validated, platform-aware install plan without executing it. */
export function buildInstallPlan({ name, method = 'auto', source, platform = process.platform, path = process.env.PATH || '', workspace = config.workspace } = {}) {
  if (!INSTALL_METHODS.has(method)) {
    throw new Error(`Unknown installation method "${method}". Supported methods: ${Array.from(INSTALL_METHODS).join(', ')}.`);
  }

  let selectedMethod = method;
  if (selectedMethod === 'auto') {
    selectedMethod = detectPackageManager({ platform, path });
    if (!selectedMethod) {
      throw new Error(`No supported package manager was detected for ${platform}. Install one or choose pip, pipx, go, cargo, npm, or git explicitly.`);
    }
  }

  const platformMethods = {
    win32: new Set(['winget', 'choco', 'scoop', 'pip', 'pipx', 'go', 'cargo', 'npm', 'git']),
    darwin: new Set(['brew', 'port', 'pip', 'pipx', 'go', 'cargo', 'npm', 'git']),
    linux: new Set(['apt', 'dnf', 'yum', 'pacman', 'zypper', 'snap', 'pip', 'pipx', 'go', 'cargo', 'npm', 'git']),
  };
  if (!platformMethods[platform]) {
    throw new Error(`Unsupported operating system "${platform}". Choose a supported Linux, macOS, or Windows environment.`);
  }
  if (!platformMethods[platform].has(selectedMethod)) {
    throw new Error(`Installation method "${selectedMethod}" is not available on ${platform}.`);
  }

  const safeName = validatePackageName(name, selectedMethod);
  const safeSource = validateSource(source, selectedMethod);
  const toolsRoot = join(resolve(workspace), '.phantom-tools');
  const packageRoot = join(toolsRoot, 'npm');
  const useSudo = ['apt', 'dnf', 'yum', 'pacman', 'zypper', 'snap'].includes(selectedMethod);
  let command;
  let workingDirectory = resolve(workspace);

  switch (selectedMethod) {
    case 'apt': command = `apt-get install -y -- ${escapeShellArg(safeName)}`; break;
    case 'dnf': command = `dnf install -y -- ${escapeShellArg(safeName)}`; break;
    case 'yum': command = `yum install -y -- ${escapeShellArg(safeName)}`; break;
    case 'pacman': command = `pacman -S --noconfirm --needed -- ${escapeShellArg(safeName)}`; break;
    case 'zypper': command = `zypper --non-interactive install -- ${escapeShellArg(safeName)}`; break;
    case 'snap': command = `snap install ${escapeShellArg(safeName)}`; break;
    case 'brew': command = `brew install ${escapeShellArg(safeName)}`; break;
    case 'port': command = `port install ${escapeShellArg(safeName)}`; break;
    case 'winget': command = `winget install --exact --accept-source-agreements --accept-package-agreements --id ${escapeShellArg(safeName)}`; break;
    case 'choco': command = `choco install --yes --no-progress ${escapeShellArg(safeName)}`; break;
    case 'scoop': command = `scoop install ${escapeShellArg(safeName)}`; break;
    case 'pip': command = `${platform === 'win32' ? 'py -m pip' : 'python3 -m pip'} install --user --disable-pip-version-check --no-input ${escapeShellArg(safeName)}`; break;
    case 'pipx': command = `pipx install ${escapeShellArg(safeName)}`; break;
    case 'go': command = `go install ${escapeShellArg(safeName)}`; break;
    case 'cargo': command = `cargo install ${escapeShellArg(safeName.includes('@') ? safeName.split('@')[0] : safeName)}${safeName.includes('@') ? ` --version ${escapeShellArg(safeName.split('@').slice(1).join('@'))}` : ''}`; break;
    case 'npm': command = `npm install --prefix ${escapeShellArg(packageRoot)} --no-save --package-lock=false --ignore-scripts ${escapeShellArg(safeName)}`; break;
    case 'git': {
      const repoName = basename(safeName);
      const repoPath = join(toolsRoot, repoName);
      command = `git clone --depth 1 ${escapeShellArg(safeSource || `https://github.com/${safeName}.git`)} ${escapeShellArg(repoPath)}`;
      break;
    }
    default: throw new Error(`Unsupported installation method "${selectedMethod}".`);
  }

  return { method: selectedMethod, platform, command, workingDirectory, useSudo, toolsRoot, packageRoot };
}

async function installTool(args = {}, onProgress) {
  try {
    const plan = buildInstallPlan(args);
    await mkdir(plan.toolsRoot, { recursive: true });
    if (onProgress) onProgress(`Installing ${args.name} with ${plan.method} in ${plan.toolsRoot}`);
    const result = await executeCommand({ command: plan.command, timeout: 300, working_directory: plan.workingDirectory, use_sudo: plan.useSudo }, onProgress);

    // If install completed without failure, register as connected in settings
    try {
      const toolKey = String(args.name || '').toLowerCase().trim();
      const connectedState = JSON.parse(getSetting('connected_tools_state', '{}') || '{}');
      connectedState[toolKey] = true;
      setSetting('connected_tools_state', JSON.stringify(connectedState));
    } catch (saveErr) {
      console.warn('[Executor] Could not update connected_tools_state:', saveErr.message);
    }

    // Automatically generate agent skill, CLI manifest, and MCP connector
    const skillNotice = await autoGenerateSkillAndMcpForTool(args.name, plan, onProgress);

    return `Install method: ${plan.method}\nInstall location: ${plan.method === 'npm' ? plan.packageRoot : plan.toolsRoot}\n${result}${skillNotice}`;
  } catch (error) {
    return `Install not started: ${error.message}\nAction: verify the package name/source and install the detected package manager, or choose an explicit supported method.`;
  }
}

/**
 * Automatically creates an agent skill, manifest, and MCP/connector
 * integration whenever a new tool is installed.
 */
export async function autoGenerateSkillAndMcpForTool(toolName, plan, onProgress) {
  try {
    const rawName = String(toolName || '').trim();
    if (!rawName) return '';
    const cleanName = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const skillsDir = join(config.workspace, 'skills', cleanName);
    await mkdir(skillsDir, { recursive: true });

    if (onProgress) onProgress(`[SkillGen] Auto-discovering capabilities and generating skill for ${cleanName}...`);

    // 1. Probe the system for tool help, switches, and capabilities
    let helpOutput = '';
    try {
      helpOutput = await executeCommand({
        command: `${cleanName} --help 2>&1 || ${cleanName} -h 2>&1 || whatis ${cleanName} 2>&1 || man -f ${cleanName} 2>&1`,
        timeout: 10,
      });
    } catch {
      helpOutput = '';
    }

    // 2. Curated knowledge fallback / enhancement for security & pentest tools
    const toolKnowledge = {
      hydra: {
        desc: 'THC-Hydra is a parallelized network logon cracker supporting SSH, FTP, HTTP, SMB, VNC, RDP, and MySQL.',
        category: 'credential-testing',
        usage: 'hydra -l <username> -P <wordlist> <target_ip> <service>',
        workflows: '- SSH brute force: `hydra -l root -P /usr/share/wordlists/rockyou.txt 192.168.1.50 ssh -t 4`\n- HTTP POST form login: `hydra -l admin -P pass.txt 192.168.1.50 http-post-form "/login.php:user=^USER^&pass=^PASS^:F=Login failed"`'
      },
      ghidra: {
        desc: 'NSA Ghidra Software Reverse Engineering Framework for binary analysis, decompilation, and vulnerability research.',
        category: 'reverse-engineering',
        usage: 'ghidraRun or analyzeHeadless <project_dir> <project_name> -import <binary>',
        workflows: '- Headless binary decompilation: `analyzeHeadless /tmp/ghidra_proj MyProj -import /path/to/binary -postScript Decompile.java`\n- Decompile and extract symbols for REA inspection.'
      },
      burpsuite: {
        desc: 'Burp Suite industry-standard web vulnerability proxy, intruder, repeater, and scanner.',
        category: 'web-security',
        usage: 'burpsuite or java -jar burpsuite.jar',
        workflows: '- Intercept HTTP/S requests via 127.0.0.1:8080.\n- Fuzz parameters using Intruder.\n- Analyze API contracts in Repeater.'
      },
      nmap: {
        desc: 'Network Mapper for host discovery, port scanning, OS detection, and NSE vulnerability scripts.',
        category: 'reconnaissance',
        usage: 'nmap -sV -sC -p- <target_ip>',
        workflows: '- Fast SYN scan: `nmap -sS -T4 -p 1-65535 <target>`\n- Vulnerability script scan: `nmap --script vuln <target>`'
      },
      sqlmap: {
        desc: 'Automated SQL injection and database takeover penetration testing engine.',
        category: 'exploitation',
        usage: 'sqlmap -u "<target_url>" --batch --dbs',
        workflows: '- Scan GET parameter: `sqlmap -u "http://target.com/item.php?id=1" --dbs`\n- Dump table: `sqlmap -u "http://target.com/item.php?id=1" -D testdb -T users --dump`'
      },
      nuclei: {
        desc: 'Fast and customizable vulnerability scanner based on simple YAML-based DSL templates.',
        category: 'vulnerability-scanner',
        usage: 'nuclei -u <target_url> -t cves/',
        workflows: '- Scan target with latest templates: `nuclei -u https://example.com`\n- Scan for critical CVEs: `nuclei -u https://example.com -severity critical,high`'
      },
      gobuster: {
        desc: 'High-speed directory, DNS sub-domain, and virtual host enumeration scanner written in Go.',
        category: 'reconnaissance',
        usage: 'gobuster dir -u <url> -w <wordlist>',
        workflows: '- Directory discovery: `gobuster dir -u http://target.com -w /usr/share/wordlists/dirb/common.txt`\n- Subdomain discovery: `gobuster dns -d target.com -w /usr/share/wordlists/subdomains.txt`'
      },
      nikto: {
        desc: 'Web server vulnerability scanner for dangerous files, outdated server packages, and misconfigurations.',
        category: 'web-security',
        usage: 'nikto -h <target_host>',
        workflows: '- Scan web server: `nikto -h https://target.com`'
      },
      tshark: {
        desc: 'Wireshark terminal-based network packet analyzer and pcap deep inspection engine.',
        category: 'packet-analysis',
        usage: 'tshark -i <interface> -f "<filter>"',
        workflows: '- Capture live traffic: `tshark -i eth0 -c 100`\n- Read pcap file: `tshark -r capture.pcap -Y "http.request.method == POST"`'
      }
    };

    const known = toolKnowledge[cleanName] || {};
    const description = known.desc || (helpOutput.slice(0, 200).replace(/\n+/g, ' ').trim() || `${cleanName} CLI tool installed on the system.`);
    const category = known.category || 'security-tool';
    const commonUsage = known.usage || `${cleanName} [options] [arguments]`;
    const workflows = known.workflows || `- Basic execution: \`${cleanName} --help\`\n- Run with custom targets or files.`;

    // 3. Write SKILL.md
    const skillMdContent = `---
name: "${cleanName}"
description: "${description.replace(/"/g, '\\"')}"
entry: "run.sh"
trust_tier: 1
version: "1.0.0"
category: "${category}"
command: "${cleanName}"
---

# ${cleanName.toUpperCase()} - Agent Skill & Automation Guide

## Overview
${description}

## Command Syntax & Flags
\`\`\`bash
${commonUsage}
\`\`\`

${helpOutput ? `### Detected CLI Help\n\`\`\`text\n${helpOutput.slice(0, 3000)}\n\`\`\`\n` : ''}

## Security & Workflow Recipes
${workflows}

## Skill Wrapper Execution
\`\`\`bash
#!/usr/bin/env bash
# Autonomous execution wrapper for ${cleanName}
exec ${cleanName} "$@"
\`\`\`
`;

    await writeFile(join(skillsDir, 'SKILL.md'), skillMdContent, 'utf8');

    // 4. Write skill.json manifest
    const skillJson = {
      name: cleanName,
      description,
      entry: 'run.sh',
      type: 'cli',
      command: cleanName,
      category,
      installed: true,
      createdAt: new Date().toISOString()
    };
    await writeFile(join(skillsDir, 'skill.json'), JSON.stringify(skillJson, null, 2), 'utf8');

    // 5. Write run.sh wrapper script
    const runShPath = join(skillsDir, 'run.sh');
    const runShContent = `#!/usr/bin/env bash\n# Wrapper for ${cleanName}\nexec ${cleanName} "$@"\n`;
    await writeFile(runShPath, runShContent, { mode: 0o755 });

    // 6. Invalidate skills cache so PHANTOM immediately picks it up
    invalidateSkillsCache();

    // 7. Check for known MCP servers or auto-connect MCP integration
    let mcpNotice = '';
    if (cleanName === 'ghidra') {
      const ghidraMcpPath = join(config.workspace, 'ghidra-mcp', 'build', 'index.js');
      if (existsSync(ghidraMcpPath)) {
        try {
          await mcpClientHub.configureServer({
            name: 'ghidra',
            command: 'node',
            args: [ghidraMcpPath]
          });
          mcpNotice = '\n- Linked to Ghidra MCP server (`ghidra`)';
        } catch (mcpErr) {
          mcpNotice = `\n- Ghidra MCP server detected: ${mcpErr.message}`;
        }
      }
    }

    // 8. Add to custom connectors list if not already present
    try {
      const customConnectors = JSON.parse(getSetting('custom_connectors', '[]') || '[]');
      if (!customConnectors.some(c => c.id === cleanName)) {
        customConnectors.push({
          id: cleanName,
          name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
          description,
          type: 'binary',
          binary: cleanName,
          category,
          entry: runShPath
        });
        setSetting('custom_connectors', JSON.stringify(customConnectors));
      }
    } catch (connErr) {
      console.warn('[Executor] Error saving custom connector:', connErr.message);
    }

    return `\n\n🎯 Autonomous Skill & MCP Configuration:
- Created Agent Skill: workspace/skills/${cleanName}/SKILL.md & skill.json
- Registered execution wrapper: workspace/skills/${cleanName}/run.sh
- Indexed CLI flags, documentation, and operational recipes for the AI agent.${mcpNotice}`;
  } catch (err) {
    console.error(`[Executor] Error in autoGenerateSkillAndMcpForTool:`, err.message);
    return `\n(Skill generation warning: ${err.message})`;
  }
}

/**
 * Make HTTP requests — enhanced with larger response limits, UA rotation, and agent-browser anti-bot fallback
 */
async function webRequest({ url, method = 'GET', headers = {}, body, follow_redirects = true }) {
  try {
    validateUrlForSSRF(url);
    // Follow redirects manually so every hop is revalidated; fetch's own
    // redirect handling would send the request to an unchecked target.
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let response;
    for (let hop = 0; hop <= 5; hop++) {
      const opts = {
        method: currentMethod,
        headers: { 'User-Agent': getRandomUA(), ...headers },
        redirect: 'manual',
      };
      if (currentBody && ['POST', 'PUT', 'PATCH'].includes(currentMethod)) {
        opts.body = currentBody;
      }
      response = await fetch(currentUrl, opts);
      const location = response.headers.get('location');
      if (!follow_redirects || ![301, 302, 303, 307, 308].includes(response.status) || !location) break;
      if (hop === 5) throw new Error('Too many redirects');
      const nextUrl = new URL(location, currentUrl).toString();
      validateUrlForSSRF(nextUrl);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      currentUrl = nextUrl;
    }
    const status = response.status;
    const respHeaders = Object.fromEntries(response.headers.entries());
    const text = await response.text();

    // Default to agent-browser if protected site / anti-bot / Cloudflare / PortSwigger blocks HTTP request
    if (status === 403 || status === 429 || /cloudflare|anti-bot|just a moment|portswigger|access denied|challenge-running/i.test(text)) {
      try {
        const browserContent = await agentBrowserAction({ action: 'open', url });
        return `[Bypassed Anti-Bot via Agent Browser]\n${browserContent}`;
      } catch {
        // Fallback to raw text if agent-browser is not able to complete
      }
    }

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
    validateUrlForSSRF(url);
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
    const resolvedPath = await resolveWorkspacePath(dirPath);
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

  const result = await executeCommand({ command: cmd, timeout: 60 }, onProgress);

  // If Scrapling runs into anti-bot challenge, PortSwigger block, or 403, seamlessly route to agent-browser!
  if (/blocked|anti-bot|cloudflare|just a moment|portswigger|turnstile|datadome|challenge|403\s+forbidden/i.test(result)) {
    if (onProgress) onProgress('[AgentBrowser] Anti-bot wall detected. Automatically engaging agent-browser CDP worker...');
    const browserResult = await agentBrowserAction({ action: 'open', url }, onProgress);
    return `[Protected Target — Rendered via Agent Browser CDP]\n${browserResult}`;
  }
  return result;
}

/**
 * Real Anti-Bot Browser via Vercel Agent Browser (https://github.com/vercel-labs/agent-browser)
 * Genuine headless Chrome with CDP that defeats Cloudflare, PortSwigger, Akamai, Datadome, etc.
 */
export async function agentBrowserAction({ action = 'open', url, selector, text, options = {} }, onProgress) {
  try {
    const act = String(action || 'open').toLowerCase().trim();
    if (onProgress) onProgress(`[AgentBrowser] Action: ${act}${url ? ` | Target: ${url}` : ''}`);

    if (act === 'open' || act === 'navigate') {
      if (!url) throw new Error('url is required for action open/navigate');
      validateUrlForSSRF(url);
      const cmd = `agent-browser open ${escapeShellArg(url)} && agent-browser snapshot -i`;
      const out = await executeCommand({ command: cmd, timeout: 60 }, onProgress);
      return out;
    }

    if (act === 'snapshot') {
      const snapCmd = options?.full ? 'agent-browser snapshot' : 'agent-browser snapshot -i';
      return await executeCommand({ command: snapCmd, timeout: 30 }, onProgress);
    }

    if (act === 'get_text') {
      const target = selector || 'body';
      const getCmd = `agent-browser get text ${escapeShellArg(target)}`;
      return await executeCommand({ command: getCmd, timeout: 30 }, onProgress);
    }

    if (act === 'click') {
      if (!selector) throw new Error('selector or element ref (@e1, @e2) is required for click');
      const clickCmd = `agent-browser click ${escapeShellArg(selector)}`;
      return await executeCommand({ command: clickCmd, timeout: 30 }, onProgress);
    }

    if (act === 'fill') {
      if (!selector) throw new Error('selector or element ref (@e1, @e2) is required for fill');
      const fillCmd = `agent-browser fill ${escapeShellArg(selector)} ${escapeShellArg(text || '')}`;
      return await executeCommand({ command: fillCmd, timeout: 30 }, onProgress);
    }

    if (act === 'screenshot') {
      const ssCmd = options?.annotate ? 'agent-browser screenshot --annotate' : 'agent-browser screenshot';
      return await executeCommand({ command: ssCmd, timeout: 30 }, onProgress);
    }

    if (act === 'download') {
      if (!url && !selector) throw new Error('url or selector is required for download');
      let dlCmd = '';
      if (url) {
        validateUrlForSSRF(url);
        dlCmd = `agent-browser open ${escapeShellArg(url)}`;
      } else {
        dlCmd = `agent-browser click ${escapeShellArg(selector)}`;
      }
      return await executeCommand({ command: dlCmd, timeout: 60 }, onProgress);
    }

    if (act === 'eval' || act === 'eval_js') {
      if (!text) throw new Error('text/expression is required for eval');
      const evalCmd = `agent-browser eval ${escapeShellArg(text)}`;
      return await executeCommand({ command: evalCmd, timeout: 30 }, onProgress);
    }

    return `Unsupported agent_browser action: ${act}. Supported: open, snapshot, click, fill, get_text, screenshot, download, eval`;
  } catch (err) {
    return `Agent Browser error: ${err.message}`;
  }
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
const delegationState = {
  active: 0,
};

export function getDelegationState() {
  return { ...delegationState };
}

async function delegateTaskTool({ task_description }, onProgress, executionContext = {}) {
  let slotAcquired = false;
  let timeoutHandle;
  try {
    if (typeof task_description !== 'string' || !task_description.trim()) {
      return 'Delegation not started: task_description is required.';
    }

    const limits = config.limits || {};
    const depth = Number.isInteger(executionContext.delegationDepth) ? executionContext.delegationDepth : 0;
    const configuredDepth = Number(limits.maxDelegationDepth);
    const maxDepth = Number.isFinite(configuredDepth) ? Math.max(0, Math.floor(configuredDepth)) : 2;
    if (depth >= maxDepth) {
      return `Delegation not started: maximum delegation depth (${maxDepth}) reached. Complete this task in the current agent or return a partial result.`;
    }

    const configuredConcurrency = Number(limits.maxDelegationConcurrency);
    const maxConcurrency = Number.isFinite(configuredConcurrency) ? Math.max(1, Math.floor(configuredConcurrency)) : 2;
    if (delegationState.active >= maxConcurrency) {
      return `Delegation not started: concurrency limit (${maxConcurrency}) reached. Retry after an active subagent finishes.`;
    }

    const maxTaskLength = 20000;
    if (task_description.length > maxTaskLength) {
      return `Delegation not started: task_description exceeds ${maxTaskLength} characters. Ask the subagent to focus on a smaller scope.`;
    }

    delegationState.active += 1;
    slotAcquired = true;
    if (onProgress) onProgress(`Spawning subagent for task: ${task_description.substring(0, 50)}...`);

    // Dynamically import processMessage to avoid circular dependencies
    const { processMessage } = await import('../ai/llm-client.js');

    // Create an isolated conversation for the subagent
    // The subagent gets a fresh conversation and explicitly opts out of shared
    // memory. This prevents unrelated sessions from leaking into its context.
    const subConv = createConversation('Subagent: ' + task_description.substring(0, 30));

    // Define an abort signal (optional)
    const ac = new AbortController();
    const configuredTimeout = Number(limits.delegationTimeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1000, Math.floor(configuredTimeout)) : 120000;
    timeoutHandle = setTimeout(() => ac.abort(), timeoutMs);
    timeoutHandle.unref?.();

    // Run the subagent
    const result = await processMessage(
      subConv.id,
      task_description,
      {
        includeSharedMemory: false,
        parentConversationId: executionContext.rootConversationId || null,
        prompt: 'You are an isolated subagent. Work only from this task and your own tool results; do not infer or import context from other conversations.',
      },
      () => {}, // ignore chunking for now
      (tc) => { if (onProgress) onProgress(`[Subagent] Using tool: ${tc.name}`); },
      () => {},
      (err) => { if (onProgress) onProgress(`[Subagent Error] ${err}`); },
      () => {},
      ac.signal,
      (tp) => { if (onProgress) onProgress(`[Subagent Tool] ${tp.name}: ${tp.text}`); },
      'delegate',
      {
        rootConversationId: executionContext.rootConversationId || subConv.id,
        delegationDepth: depth + 1,
      }
    );

    const conciseResult = compactSubagentResult(result, limits.maxDelegationResultChars ?? 12000);
    return `Subagent completed task (isolated conversation ${subConv.id}). Result:\n\n${conciseResult}`;
  } catch (error) {
    return `Error delegating task: ${error.message}`;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (slotAcquired && delegationState.active > 0) delegationState.active -= 1;
  }
}

function compactSubagentResult(result, maxChars) {
  const text = String(result ?? '').trim();
  const limit = Math.max(1000, Number(maxChars) || 12000);
  if (text.length <= limit) return text || 'The subagent returned no text.';
  const tailLength = Math.min(1200, Math.floor(limit / 4));
  return `${text.slice(0, limit - tailLength - 40)}\n… [subagent result truncated] …\n${text.slice(-tailLength)}`;
}

async function getSystemCapabilitiesTool() {
  const skillsDir = join(config.workspace, 'skills');
  return getSystemCapabilities(skillsDir);
}
