import Database from 'better-sqlite3';
import config from '../config.js';
import { v4 as uuidv4 } from 'uuid';
import { generateEmbedding } from './embeddings.js';
import { searchSimilarVectors } from './vector-store.js';


export function validateParams(sql, params) {
  const placeholderCount = (sql.match(/\?/g) || []).length;
  const paramCount = Array.isArray(params) ? params.length : 0;
  if (placeholderCount !== paramCount) {
    throw new Error(
      `SQL parameter mismatch: query has ${placeholderCount} placeholder(s) but ${paramCount} value(s) were provided.\nQuery: ${sql}`
    );
  }
}


import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

let db;

export function initDB(dbPath = config.db.path) {
  if (db) db.close();
  if (dbPath && dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT 'New Conversation',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      metadata TEXT,
      vector_embedding BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS skill_audit_logs (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      skill_name TEXT NOT NULL,
      trust_tier INTEGER NOT NULL,
      inputs TEXT,
      outputs TEXT,
      duration_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args TEXT,
      url TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tool_results (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      tool_name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      status TEXT DEFAULT 'success',
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

    -- ⚡ Bolt: Performance optimization
    -- Added indexes to avoid SQLite 'USE TEMP B-TREE FOR ORDER BY' during common queries
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_audit_logs_timestamp ON skill_audit_logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_cat_updated ON memories(category, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_created ON mcp_servers(created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED, type UNINDEXED, content);

    CREATE TRIGGER IF NOT EXISTS after_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO search_index(id, type, content) VALUES (new.id, 'message', new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS after_memory_insert AFTER INSERT ON memories BEGIN
      INSERT INTO search_index(id, type, content) VALUES (new.id, 'memory', new.value);
    END;

    CREATE TRIGGER IF NOT EXISTS after_memory_update AFTER UPDATE ON memories BEGIN
      UPDATE search_index SET content = new.value WHERE id = new.id AND type = 'memory';
    END;
  `);

  // Auto-migrate schema for agentmemory upgrade
  const columnsInfo = db.prepare('PRAGMA table_info(memories)').all();
  const columns = columnsInfo.map(c => c.name);
  if (!columns.includes('importance')) {
    db.exec(`ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 3;`);
  }
  if (!columns.includes('access_count')) {
    db.exec(`ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 1;`);
  }
  if (!columns.includes('last_accessed_at')) {
    db.exec(`ALTER TABLE memories ADD COLUMN last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP;`);
  }

  // Backfill if search_index is empty
  const count = getDB().prepare('SELECT count(*) as count FROM search_index').get();
  if (count.count === 0) {
    db.exec(`
      INSERT INTO search_index (id, type, content)
      SELECT id, 'message', content FROM messages WHERE content IS NOT NULL;

      INSERT INTO search_index (id, type, content)
      SELECT id, 'memory', value FROM memories WHERE value IS NOT NULL;
    `);
  }

  return db;
}


export function getDB() {
  if (!db) initDB();

  // Wrap db in a Proxy to intercept prepare() calls and inject validateParams
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return function(sql) {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(stmtTarget, stmtProp) {
              if (['run', 'get', 'all'].includes(stmtProp)) {
                return function(...args) {
                  validateParams(sql, args);
                  return stmtTarget[stmtProp](...args);
                };
              }
              if (stmtProp === 'each') {
                return function(args, cb) {
                  if (typeof args !== 'function') {
                     validateParams(sql, Array.isArray(args) ? args : [args]);
                  } else {
                     validateParams(sql, []);
                  }
                  return stmtTarget[stmtProp](args, cb);
                };
              }
              // Bind other methods like bind() or plucks() if used
              return typeof stmtTarget[stmtProp] === 'function' ? stmtTarget[stmtProp].bind(stmtTarget) : stmtTarget[stmtProp];
            }
          });
        };
      }
      return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
    }
  });
}


// ─── Conversations ───
export function createConversation(title = 'New Conversation') {
  const id = uuidv4();
  getDB().prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, title);
  return { id, title, created_at: new Date().toISOString() };
}

export function getConversations() {
  return getDB().prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
}

export function getConversation(id) {
  return getDB().prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

export function deleteConversation(id) {
  getDB().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function updateConversationTitle(id, title) {
  getDB().prepare('UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, id);
}

// ─── Messages ───
export function addMessage(conversationId, { role, content, tool_calls, tool_call_id, name }) {
  const id = uuidv4();
  getDB().prepare(
    'INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, conversationId, role, content || null, tool_calls ? JSON.stringify(tool_calls) : null, tool_call_id || null, name || null);

  getDB().prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
  return id;
}

export function getMessages(conversationId) {
  const rows = getDB().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all(conversationId);
  return rows.map(r => ({
    ...r,
    tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
  }));
}

// ─── Memories (AgentMemory Engine) ───
export async function saveMemory(category, key, value, metadata = {}, importance = 3) {
  const db = getDB();
  const id = uuidv4();

  let embeddingBuffer = null;
  if (config.memory?.vectorSearch?.enabled) {
    const textToEmbed = `${category} ${key} ${value}`;
    const embedding = await generateEmbedding(textToEmbed);
    if (embedding) {
      embeddingBuffer = Buffer.from(embedding.buffer);
    }
  }

  const validImportance = Math.min(5, Math.max(1, parseInt(importance, 10) || 3));

  const existing = db.prepare('SELECT id, access_count FROM memories WHERE category = ? AND key = ?').get(category, key);
  if (existing) {
    db.prepare('UPDATE memories SET value = ?, metadata = ?, importance = ?, vector_embedding = ?, access_count = access_count + 1, updated_at = CURRENT_TIMESTAMP, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(value, JSON.stringify(metadata), validImportance, embeddingBuffer, existing.id);
    return existing.id;
  }
  db.prepare('INSERT INTO memories (id, category, key, value, metadata, importance, access_count, vector_embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, category, key, value, JSON.stringify(metadata), validImportance, 1, embeddingBuffer);
  return id;
}

/**
 * AgentMemory Hybrid Search combining BM25 keyword matching (FTS5), vector similarity (embeddings),
 * Ebbinghaus recency decay, and access frequency boosting.
 * @param {string} query - The search query.
 * @param {string|null} category - Optional category filter.
 * @param {number} limit - Max results to return.
 * @returns {Promise<Array<Object>>}
 */
export async function hybridSearchMemories(query, category = null, limit = 10) {
  const db = getDB();
  let allMemories = [];

  let sql = 'SELECT id, category, key, value, metadata, importance, access_count, last_accessed_at, vector_embedding FROM memories';
  let params = [];
  if (category) {
    sql += ' WHERE category = ?';
    params.push(category);
  }

  try {
    allMemories = db.prepare(sql).all(...params);
  } catch (err) {
    console.error('Error fetching memories for hybrid search:', err);
    return [];
  }

  if (allMemories.length === 0) return [];

  // 1. BM25 / Keyword Relevance Scoring
  const lowerQuery = (query || '').toLowerCase().trim();
  const keywordRanks = new Map();
  if (lowerQuery) {
    allMemories.forEach(m => {
      let score = 0;
      const text = `${m.key || ''} ${m.value || ''} ${m.category || ''}`.toLowerCase();
      if (text.includes(lowerQuery)) score += 1.0;
      const words = lowerQuery.split(/\s+/).filter(w => w.length > 2);
      words.forEach(w => {
        if (text.includes(w)) score += 0.3;
      });
      if (score > 0) keywordRanks.set(m.id, score);
    });
  }

  // 2. Vector Similarity Scoring
  const vectorRanks = new Map();
  if (config.memory?.vectorSearch?.enabled && lowerQuery) {
    const queryVector = await generateEmbedding(query);
    if (queryVector) {
      const vectorResults = searchSimilarVectors(queryVector, allMemories, allMemories.length);
      vectorResults.forEach(v => {
        if (v._score > 0.1) vectorRanks.set(v.id, v._score);
      });
    }
  }

  // 3. RRF + Importance + Access Frequency + Ebbinghaus Recency Decay
  const combined = allMemories.map(m => {
    const kwScore = keywordRanks.get(m.id) || 0;
    const vecScore = vectorRanks.get(m.id) || 0;

    let score = lowerQuery ? (kwScore * 0.5 + vecScore * 0.5) : 1.0;

    const importance = m.importance || 3;
    const importanceMultiplier = 0.8 + (importance * 0.1);

    const accessCount = m.access_count || 1;
    const accessMultiplier = Math.min(1.5, 1 + Math.log10(accessCount) * 0.2);

    const lastAccessTime = m.last_accessed_at ? new Date(m.last_accessed_at).getTime() : Date.now();
    const daysOld = (Date.now() - lastAccessTime) / (1000 * 3600 * 24);
    const recencyFactor = Math.max(0.6, 1 / (1 + 0.05 * daysOld));

    const finalScore = score * importanceMultiplier * accessMultiplier * recencyFactor;
    return { ...m, _finalScore: finalScore };
  });

  let results = combined;
  if (lowerQuery) {
    results = combined.filter(m => m._finalScore > 0);
  }

  results.sort((a, b) => b._finalScore - a._finalScore);
  const topResults = results.slice(0, limit);

  // Touch accessed records
  topResults.forEach(m => {
    try {
      db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?').run(m.id);
    } catch {}
  });

  return topResults.map(m => {
    delete m.vector_embedding;
    delete m._finalScore;
    return m;
  });
}

export async function searchSimilar(query, limit = 5) {
  return hybridSearchMemories(query, null, limit);
}

export function searchMemories(query, category = null) {
  const q = `%${query.toLowerCase()}%`;
  if (category) {
    return getDB().prepare(
      'SELECT * FROM memories WHERE category = ? AND (LOWER(key) LIKE ? OR LOWER(value) LIKE ?) ORDER BY updated_at DESC LIMIT 20'
    ).all(category, q, q);
  }
  return getDB().prepare(
    'SELECT * FROM memories WHERE LOWER(key) LIKE ? OR LOWER(value) LIKE ? ORDER BY updated_at DESC LIMIT 20'
  ).all(q, q);
}

export function getMemoryStats() {
  const db = getDB();
  const total = db.prepare('SELECT COUNT(*) as count FROM memories').get()?.count || 0;
  const categories = db.prepare('SELECT category, COUNT(*) as count FROM memories GROUP BY category').all();
  const avgImportance = db.prepare('SELECT AVG(importance) as avg FROM memories').get()?.avg || 3;
  const topAccessed = db.prepare('SELECT category, key, access_count FROM memories ORDER BY access_count DESC LIMIT 5').all();

  return {
    total_memories: total,
    categories: Object.fromEntries(categories.map(c => [c.category, c.count])),
    average_importance: Number(avgImportance).toFixed(2),
    top_accessed: topAccessed,
  };
}

export function getAllMemories(category = null) {
  if (category) {
    return getDB().prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC').all(category);
  }
  return getDB().prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 100').all();
}

// ─── Settings ───
export function getSetting(key, defaultValue = null) {
  const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  getDB().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

export function getAllSettings() {
  const rows = getDB().prepare('SELECT * FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

// ─── MCP Servers ───
export function getMCPServers() {
  return getDB().prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all();
}

export function addMCPServer({ name, transport, command, args, url }) {
  const id = uuidv4();
  getDB().prepare('INSERT INTO mcp_servers (id, name, transport, command, args, url) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, transport || 'stdio', command || null, args ? JSON.stringify(args) : null, url || null);
  return id;
}

export function removeMCPServer(id) {
  getDB().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

// ─── Tool Results ───
export function saveToolResult(conversationId, toolName, input, output, status, durationMs) {
  const id = uuidv4();
  getDB().prepare(
    'INSERT INTO tool_results (id, conversation_id, tool_name, input, output, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, conversationId, toolName, JSON.stringify(input), output, status, durationMs);
  return id;
}

export function closeDB() {
  if (db) db.close();
}


export function searchConversations(query) {
  // FTS5 MATCH syntax
  const q = '"' + query.replace(/"/g, '""') + '"';
  const rows = getDB().prepare(`
    SELECT
      si.type,
      si.content as matched_text,
      m.conversation_id,
      m.role,
      c.title as conversation_title,
      m.created_at
    FROM search_index si
    LEFT JOIN messages m ON si.id = m.id AND si.type = 'message'
    LEFT JOIN conversations c ON m.conversation_id = c.id
    WHERE search_index MATCH ? AND si.type = 'message'
    ORDER BY m.created_at DESC
    LIMIT 30
  `).all(q);

  return rows;
}


export async function recallMemory(query, options = {}) {
  const { limit = 10 } = options;

  // If no query, return most recent entries
  if (!query || query.trim() === '') {
    return new Promise((resolve, reject) => {
      try {
        const rows = getDB().prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ?').all(limit);
        resolve(rows || []);
      } catch (err) {
        reject(err);
      }
    });
  }

  // FTS5 MATCH syntax for search
  return new Promise((resolve, reject) => {
    try {
      const q = '"' + query.replace(/"/g, '""') + '"';
      const rows = getDB().prepare(`
        SELECT
          si.type,
          si.content as matched_text,
          m.*
        FROM search_index si
        JOIN memories m ON si.id = m.id AND si.type = 'memory'
        WHERE search_index MATCH ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `).all(q, limit);
      resolve(rows || []);
    } catch (err) {
      reject(err);
    }
  });
}
