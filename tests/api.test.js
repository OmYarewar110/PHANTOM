import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../server/app.js';
import { v4 as uuidv4 } from 'uuid';

let globalIpCounter = 1;

describe('API Auth Middleware', () => {
  const originalToken = process.env.API_TOKEN;
  let testIp;

  beforeEach(() => {
    process.env.API_TOKEN = 'test-secret-token';
    // Use valid IP strings instead of generic UUID to prevent express-rate-limit ERR_ERL_INVALID_IP_ADDRESS
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    testIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.API_TOKEN;
    } else {
      process.env.API_TOKEN = originalToken;
    }
  });

  it('should return 401 when API_TOKEN is set but no token provided', async () => {
    const res = await request(app).get('/api/settings').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(401);
  });

  it('should return 401 when API_TOKEN is set but wrong token provided', async () => {
    const res = await request(app).get('/api/settings').set('Authorization', 'Bearer wrong-token').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(401);
  });

  it('should allow access when API_TOKEN is set and correct token provided', async () => {
    // we just need it to bypass the auth middleware, returning 200 or whatever the route does
    // since initDB isn't called here, we might get 500, but we shouldn't get 401
    const res = await request(app).get('/api/system/info').set('Authorization', 'Bearer test-secret-token').set('X-Forwarded-For', testIp);
    expect(res.status).not.toBe(401);
  });
});

describe('Security Middlewares', () => {
  let testIp;
  beforeEach(() => {
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    testIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;
  });

  it('should include helmet security headers', async () => {
    const res = await request(app).get('/api/settings').set('X-Forwarded-For', testIp);
    expect(res.headers['x-powered-by']).toBeUndefined(); // Helmet removes this by default
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN'); // Helmet sets this
    expect(res.headers['x-content-type-options']).toBe('nosniff'); // Helmet sets this
  });

  it('should enforce rate limiting on /api routes', async () => {
    const rateLimitIp = `192.168.99.${globalIpCounter++}`; // Use a dedicated fresh IP for rate limit test
    // Make 100 requests (the limit)
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(request(app).get('/api/settings').set('X-Forwarded-For', rateLimitIp));
    }
    await Promise.all(promises);

    // The 101st request should be blocked by rate limit
    const res = await request(app).get('/api/settings').set('X-Forwarded-For', rateLimitIp);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too many requests, please try again later.');
  }, 20000);
});

import { initDB, closeDB } from '../server/memory/store.js';

describe('API Routes', () => {
  const originalToken = process.env.API_TOKEN;
  let testIp;

  beforeEach(() => {
    delete process.env.API_TOKEN;
    initDB(':memory:');
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    testIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.API_TOKEN;
    } else {
      process.env.API_TOKEN = originalToken;
    }
    closeDB();
  });

  it('GET /api/settings should return 200 with valid JSON', async () => {
    const res = await request(app).get('/api/settings').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
  });

  it('GET /api/tools should return an array of tool definitions', async () => {
    const res = await request(app).get('/api/tools').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('name');
  });

  it('GET /api/memory should return 200', async () => {
    const res = await request(app).get('/api/memory').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/conversations should create a conversation and return its id', async () => {
    // We must use a unique IP for this test to avoid hitting the global rate limit
    // established by previous tests if they ran too many requests.
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    const uniqueTestIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;
    const res = await request(app).post('/api/conversations').set('X-Forwarded-For', uniqueTestIp).send({ title: 'Test Conv' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.title).toBe('Test Conv');
  });

  it('GET /api/conversations/:id/export should export conversation to markdown', async () => {
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    const uniqueTestIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;

    // Create conversation
    const convRes = await request(app).post('/api/conversations').set('X-Forwarded-For', uniqueTestIp).send({ title: 'Export Test' });
    const convId = convRes.body.id;

    // Add some messages manually to test the export formatting via store.js
    const { addMessage } = await import('../server/memory/store.js');
    addMessage(convId, { role: 'user', content: 'Hello' });
    addMessage(convId, { role: 'assistant', content: 'World' });

    const res = await request(app).get(`/api/conversations/${convId}/export`).set('X-Forwarded-For', uniqueTestIp);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment; filename=phantom_export_');
    expect(res.text).toContain('# Export Test');
    expect(res.text).toContain('## 👤 User');
    expect(res.text).toContain('Hello');
    expect(res.text).toContain('## 👻 PHANTOM');
    expect(res.text).toContain('World');
  });

  it('GET /api/conversations/:id/export?format=html should export conversation to html', async () => {
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    const uniqueTestIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;

    // Create conversation
    const convRes = await request(app).post('/api/conversations').set('X-Forwarded-For', uniqueTestIp).send({ title: 'HTML Export Test' });
    const convId = convRes.body.id;

    // Add some messages manually to test the export formatting via store.js
    const { addMessage } = await import('../server/memory/store.js');
    addMessage(convId, { role: 'user', content: 'HTML Hello' });
    addMessage(convId, { role: 'assistant', content: 'HTML World' });

    const res = await request(app).get(`/api/conversations/${convId}/export?format=html`).set('X-Forwarded-For', uniqueTestIp);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toContain('attachment; filename=phantom_export_');
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('HTML Export Test');
    expect(res.text).toContain('HTML Hello');
    expect(res.text).toContain('HTML World');
  });

  it('GET /api/system/info should return 200', async () => {
    const res = await request(app).get('/api/system/info').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('hostname');
    expect(res.body).toHaveProperty('platform');
  });

  it('GET /api/workspace/file should reject path traversal requests', async () => {
    const res1 = await request(app).get('/api/workspace/file?path=../package.json').set('X-Forwarded-For', testIp);
    expect(res1.status).toBe(403);
    expect(res1.body.error).toContain('Access denied');
  });

  it('DELETE /api/skills/:name should reject invalid skill names (path traversal)', async () => {
    const res1 = await request(app).delete('/api/skills/..%2Fsecret').set('X-Forwarded-For', testIp);
    expect(res1.status).toBe(404); // The router actually fails to match the route for ..%2Fsecret and goes to 404 handler, or the param is not matching.

    const res2 = await request(app).delete('/api/skills/%21%40%23%24').set('X-Forwarded-For', testIp);
    expect(res2.status).toBe(400);
  });


  it('POST /api/skills/upload should reject zip files containing path traversal (Zip Slip)', async () => {
    const res = await request(app)
      .post('/api/skills/upload')
      .set('X-Forwarded-For', testIp)
      .attach('file', 'tests/evil.zip');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Malicious zip file detected: Invalid path');
  });

  it('POST /api/skills/upload should accept safe zip files', async () => {
    const res = await request(app)
      .post('/api/skills/upload')
      .set('X-Forwarded-For', testIp)
      .attach('file', 'tests/safe.zip');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.name).toBe('safe');
  });
});
describe('API Routes Error Handling', () => {
  let testIp;
  beforeEach(() => {
    const octet3 = Math.floor(globalIpCounter / 256);
    const octet4 = globalIpCounter % 256;
    testIp = `192.168.${octet3}.${octet4}`;
    globalIpCounter++;
  });

  it('GET /api/conversations/:id should return 500 when database throws an error', async () => {
    // We will cause a SQLite error by closing the DB before the request
    closeDB();
    const res = await request(app).get('/api/conversations/123').set('X-Forwarded-For', testIp);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    // Re-initialize for subsequent tests
    initDB(':memory:');
  });

  describe('Sudo Validation Endpoint (/api/sudo/validate)', () => {
    it('should return 400 or invalid status if password is not a string (Object Injection)', async () => {
      // Simulate windows behavior bypass for the test if it's on Windows
      if (process.platform === 'win32') return;

      const res = await request(app)
        .post('/api/sudo/validate')
        .send({ password: { length: 50, replace: 'malicious' } }) // object instead of string
        .expect('Content-Type', /json/)
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.message).toBe('Invalid password format');
    });
  });
});
