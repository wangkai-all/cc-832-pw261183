// Zero-dependency HTTP server: JSON API + static web/core modules.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ProjectStore } from './store.js';
import { SAMPLES } from '../core/samples.js';
import { boxesCsv, jobToJson, ledgerCsv, markdownReport } from '../core/exporters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WEB_DIR = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

export function createServer({ store = new ProjectStore() } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, url, store);
        return;
      }

      await serveStatic(req, res, pathname);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: { code: error.code || 'SERVER_ERROR', message: error.message },
      });
    }
  });
}

async function handleApi(req, res, url, store) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'credible-range-studio', time: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(res, 200, { ok: true, samples: SAMPLES, ...store.bootstrap() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/project') {
    sendJson(res, 200, { ok: true, project: store.publicProject() });
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/project') {
    const body = await readJsonBody(req);
    const project = store.saveDraft(body.config || body);
    sendJson(res, 200, { ok: true, project });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/analyze') {
    const body = await readJsonBody(req);
    try {
      const { analyzeModel } = await import('../core/analyzer.js');
      const result = analyzeModel(body.config || body, body.options || body);
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 422, {
        ok: false,
        error: error.toJSON ? error.toJSON() : { code: error.code, message: error.message, details: error.details },
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    const body = await readJsonBody(req);
    const job = store.createJob(body);
    sendJson(res, job.status === 'completed' ? 201 : 422, { ok: job.status === 'completed', job });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    sendJson(res, 200, { ok: true, jobs: store.listJobs() });
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(\/export|\/dependency-graph)?$/);
  if (req.method === 'GET' && jobMatch) {
    const job = store.getJob(decodeURIComponent(jobMatch[1]));
    if (!job) {
      sendJson(res, 404, { ok: false, error: { code: 'JOB_NOT_FOUND', message: '任务不存在' } });
      return;
    }

    if (jobMatch[2] === '/dependency-graph') {
      sendJson(res, 200, { ok: true, graph: job.result?.dependencyGraph || job.error?.details?.graph || null });
      return;
    }

    if (jobMatch[2] === '/export') {
      const format = url.searchParams.get('format') || 'json';
      sendExport(res, job, format);
      return;
    }

    sendJson(res, 200, { ok: true, job });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知 API：${pathname}` } });
}

function sendExport(res, job, format) {
  const id = job.id;
  if (format === 'json') {
    const body = jobToJson(job);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${id}.json"`,
    });
    res.end(body);
    return;
  }
  if (format === 'ledger.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${id}-ledger.csv"`,
    });
    res.end(ledgerCsv(job));
    return;
  }
  if (format === 'boxes.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${id}-boxes.csv"`,
    });
    res.end(boxesCsv(job));
    return;
  }
  if (format === 'md' || format === 'markdown') {
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${id}.md"`,
    });
    res.end(markdownReport(job));
    return;
  }
  sendJson(res, 400, { ok: false, error: { code: 'BAD_FORMAT', message: '支持 json, ledger.csv, boxes.csv, md' } });
}

async function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath;
  if (relative.startsWith('src/')) {
    filePath = path.normalize(path.join(ROOT, relative));
  } else {
    filePath = path.normalize(path.join(WEB_DIR, relative));
  }

  const srcDir = path.join(ROOT, 'src');
  const isInside = (candidate, directory) =>
    candidate === directory || candidate.startsWith(directory + path.sep);

  if (!isInside(filePath, WEB_DIR) && !isInside(filePath, srcDir)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA-ish fallback for root only; avoid masking missing module paths.
    if (pathname === '/' || pathname === '/index.html') {
      const fallback = await readFile(path.join(WEB_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(fallback);
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'STATIC_NOT_FOUND', message: pathname } });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(Object.assign(new Error('请求体过大'), {
          statusCode: 413,
          code: 'PAYLOAD_TOO_LARGE',
        }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), {
          statusCode: 400,
          code: 'INVALID_JSON',
        }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// Allow `node src/server/app.js` as well as `npm start` -> server.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`Credible Range Studio running at http://${host}:${port}`);
  });
}
