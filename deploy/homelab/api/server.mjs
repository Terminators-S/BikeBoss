import { createServer } from 'node:http';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker from '../../../backend/src/index.js';
import { D1SqliteDatabase } from './d1-sqlite.mjs';
import { LocalFirmwareBucket } from './local-firmware.mjs';

const port = Number(process.env.PORT ?? 8787);
const databasePath = resolve(process.env.BIKEBOSS_DB_PATH ?? '/data/bikeboss.sqlite');
const schemaPath = resolve(process.env.BIKEBOSS_SCHEMA_PATH ?? '/app/backend/schema.sql');
const importPath = resolve(process.env.BIKEBOSS_IMPORT_SQL ?? '/data/import.sql');
const firmwareRoot = resolve(process.env.BIKEBOSS_FIRMWARE_ROOT ?? '/firmware');
const backupRoot = resolve(process.env.BIKEBOSS_BACKUP_ROOT ?? '/backups');
const backupRetentionDays = Math.max(1, Number(process.env.BIKEBOSS_BACKUP_RETENTION_DAYS ?? 14));
const maximumAdapterBodyBytes = 128 * 1024;

await mkdir(resolve(databasePath, '..'), { recursive: true });
await mkdir(firmwareRoot, { recursive: true });
await mkdir(backupRoot, { recursive: true });

const database = new D1SqliteDatabase(databasePath, { schemaPath, importPath });
const env = {
  ...process.env,
  DB: database,
  FIRMWARE: new LocalFirmwareBucket(firmwareRoot),
};

function executionContext() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
    async drain() {
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(JSON.stringify({
            message: 'background_task_failed',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }));
        }
      }
    },
  };
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumAdapterBodyBytes) {
      const error = new Error('request_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function requestUrl(request) {
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const protocol = forwardedProtocol || 'http';
  const host = request.headers.host || `127.0.0.1:${port}`;
  return `${protocol}://${host}${request.url || '/'}`;
}

async function sendResponse(nodeResponse, response, method) {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  for (const [name, value] of response.headers) nodeResponse.setHeader(name, value);
  if (method === 'HEAD' || !response.body) {
    nodeResponse.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), nodeResponse);
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  try {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await requestBody(request);
    const webRequest = new Request(requestUrl(request), {
      method: request.method,
      headers: request.headers,
      body,
    });
    const ctx = executionContext();
    const workerResponse = await worker.fetch(webRequest, env, ctx);
    void ctx.drain();
    await sendResponse(response, workerResponse, request.method);
    console.log(JSON.stringify({
      message: 'request_complete',
      method: request.method,
      path: new URL(webRequest.url).pathname,
      status: workerResponse.status,
      duration_ms: Date.now() - startedAt,
    }));
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (!response.headersSent) {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: status === 413 ? 'request_too_large' : 'internal_server_error' }));
    } else {
      response.destroy(error);
    }
    console.error(JSON.stringify({
      message: 'adapter_request_failed',
      status,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

async function runScheduled(cron) {
  const ctx = executionContext();
  try {
    await worker.scheduled({ cron, scheduledTime: Date.now() }, env, ctx);
    await ctx.drain();
  } catch (error) {
    console.error(JSON.stringify({
      message: 'scheduled_task_failed',
      cron,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function createDailyBackup(now) {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const target = resolve(backupRoot, `bikeboss-${stamp}.sqlite`);
  await database.backupTo(target);
  const cutoff = now.getTime() - backupRetentionDays * 24 * 60 * 60 * 1000;
  const files = await readdir(backupRoot, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !/^bikeboss-.+\.sqlite$/u.test(file.name)) continue;
    const filePath = resolve(backupRoot, file.name);
    const details = await stat(filePath);
    if (details.mtimeMs < cutoff) await unlink(filePath);
  }
  console.log(JSON.stringify({ message: 'database_backup_complete', file: target }));
}

let lastFiveMinuteRun = '';
let lastDailyRun = '';
let lastBackupRun = '';
async function schedulerTick() {
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16);
  const dayKey = now.toISOString().slice(0, 10);
  if (now.getUTCMinutes() % 5 === 0 && minuteKey !== lastFiveMinuteRun) {
    lastFiveMinuteRun = minuteKey;
    void runScheduled('*/5 * * * *');
  }
  if (now.getUTCHours() === 9 && now.getUTCMinutes() === 0 && dayKey !== lastDailyRun) {
    lastDailyRun = dayKey;
    void runScheduled('0 9 * * *');
  }
  if (now.getUTCHours() === 3 && now.getUTCMinutes() === 15 && dayKey !== lastBackupRun) {
    lastBackupRun = dayKey;
    void createDailyBackup(now).catch((error) => console.error(JSON.stringify({
      message: 'database_backup_failed',
      error: error instanceof Error ? error.message : String(error),
    })));
  }
}

setInterval(schedulerTick, 30_000).unref();
void runScheduled('*/5 * * * *');

async function shutdown(signal) {
  console.log(JSON.stringify({ message: 'shutdown_started', signal }));
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ message: 'bikeboss_homelab_api_started', port }));
});
