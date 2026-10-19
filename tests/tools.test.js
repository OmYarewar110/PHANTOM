import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeTool, validateUrlForSSRF } from '../server/tools/executor.js';
import { initDB, closeDB, saveMemory, searchMemories } from '../server/memory/store.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import config from '../server/config.js';
import { reaCapabilities, validateReaTarget } from '../server/tools/rea.js';


vi.mock('@xenova/transformers', () => {
  return {
    pipeline: vi.fn().mockResolvedValue(async () => {
      return { data: new Float32Array(384).fill(0.1) };
    }),
  };
});

describe('Tools Executor', () => {
  let tempDir;
  let originalWorkspace;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'phantom-test-'));
    originalWorkspace = config.workspace;
    config.workspace = tempDir;
  });

  afterEach(async () => {
    config.workspace = originalWorkspace;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('execute_command should return stdout', async () => {
    const result = await executeTool('execute_command', { command: 'echo "hello phantom"' });
    expect(result).toContain('hello phantom');
  });

  it('read_file and write_file should work correctly', async () => {
    const testFile = join(tempDir, 'test.txt');
    const content = 'Hello world';

    const writeResult = await executeTool('write_file', { path: testFile, content });
    expect(writeResult).toContain('File written successfully');

    const readResult = await executeTool('read_file', { path: testFile });
    expect(readResult).toBe(content);
  });

  it('list_directory should return filenames', async () => {
    const testFile = join(tempDir, 'test1.txt');
    await executeTool('write_file', { path: testFile, content: 'test' });

    const result = await executeTool('list_directory', { path: tempDir });
    expect(result).toContain('test1.txt');
  });
});

describe('REA bridge', () => {
  it('reports the pinned package and safe default target policy', () => {
    const capabilities = reaCapabilities();
    expect(capabilities.package).toBe('rea-agents');
    expect(capabilities.version).toBe('6.7.0');
    expect(capabilities.externalTargetsAllowed).toBe(false);
  });

  it('rejects missing targets before starting the REA process', () => {
    expect(() => validateReaTarget(join(config.root, 'phantom-target-that-does-not-exist')))
      .toThrow('REA target does not exist');
  });
});

describe('Memory Store', () => {
  beforeEach(() => {
    initDB(':memory:');
  });

  afterEach(() => {
    closeDB();
  });

  it('save_memory and recall_memory should round-trip correctly', async () => {
    await saveMemory('Test', 'test-key', 'test-value');
    const results = searchMemories('test');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe('Test');
    expect(results[0].key).toBe('test-key');
    expect(results[0].value).toBe('test-value');
  }, 50000);
});

describe('validateUrlForSSRF', () => {
  it('should allow valid http and https URLs', () => {
    expect(() => validateUrlForSSRF('http://example.com')).not.toThrow();
    expect(() => validateUrlForSSRF('https://example.com')).not.toThrow();
    expect(() => validateUrlForSSRF('https://example.com/path?query=1')).not.toThrow();
  });

  it('should throw on invalid URL formats', () => {
    expect(() => validateUrlForSSRF('not_a_url')).toThrow('Invalid URL format');
    expect(() => validateUrlForSSRF('http://')).toThrow('Invalid URL format');
  });

  it('should throw on invalid protocols', () => {
    expect(() => validateUrlForSSRF('ftp://example.com')).toThrow('Invalid URL protocol. Only http and https are allowed.');
    expect(() => validateUrlForSSRF('file:///etc/passwd')).toThrow('Invalid URL protocol. Only http and https are allowed.');
    expect(() => validateUrlForSSRF('data:text/plain;base64,SGVsbG8sIFdvcmxkIQ%3D%3D')).toThrow('Invalid URL protocol. Only http and https are allowed.');
  });

  it('should throw on exact matches for forbidden hosts', () => {
    const forbidden = ['localhost', '127.0.0.1', '169.254.169.254', '0.0.0.0', '[::1]', '[0:0:0:0:0:0:0:1]'];
    for (const host of forbidden) {
      expect(() => validateUrlForSSRF(`http://${host}`)).toThrow('Access to internal/local hostnames is forbidden (SSRF protection).');
    }
  });

  it('should throw on IPv4 loopback and ANY variants', () => {
    expect(() => validateUrlForSSRF('http://127.0.0.2')).toThrow('Access to loopback/ANY addresses is forbidden (SSRF protection).');
    expect(() => validateUrlForSSRF('http://127.12.34.56')).toThrow('Access to loopback/ANY addresses is forbidden (SSRF protection).');
  });

  it('should throw on AWS metadata IP', () => {
    expect(() => validateUrlForSSRF('http://169.254.169.254/latest/meta-data/')).toThrow('Access to internal/local hostnames is forbidden (SSRF protection).');
  });

  it('should throw on IPv6 loopback variants', () => {
    expect(() => validateUrlForSSRF('http://[::1]')).toThrow('Access to internal/local hostnames is forbidden (SSRF protection).');
    expect(() => validateUrlForSSRF('http://[0:0:0:0:0:0:0:1]')).toThrow('Access to internal/local hostnames is forbidden (SSRF protection).');
  });

  it('should throw on dynamic DNS loopbacks and local domains', () => {
    const forbiddenDomains = [
      'test.localhost',
      '127.0.0.1.nip.io',
      '127.0.0.1.xip.io',
      '127.0.0.1.sslip.io',
      'sub.127.0.0.1.nip.io'
    ];
    for (const domain of forbiddenDomains) {
      expect(() => validateUrlForSSRF(`http://${domain}`)).toThrow('Access to dynamic DNS loopbacks/local domains is forbidden (SSRF protection).');
    }
  });

  it('web_request should handle SSRF validation failure gracefully', async () => {
    const result = await executeTool('web_request', { url: 'http://localhost' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^Request error:/);
  });

  it('scrape_webpage should handle SSRF validation failure gracefully', async () => {
    const result = await executeTool('scrape_webpage', { url: 'http://localhost' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^Scrape error:/);
  });
});
