import type { ProjectEntry, ServerConfig, TaskCreateRequest } from './types.js';
import { loadProjects } from './config.js';
import { createTask } from './entry/task-factory.js';
import { parseGitHubEvent, verifyWebhookSignature } from './entry/github-webhook.js';
import { startScanners } from './entry/scanners/index.js';
import { buildPipelineConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { createLogger } from './util/logger.js';

const log = createLogger();

/**
 * Start the Case orchestrator as an HTTP service using Bun.serve.
 *
 * Endpoints:
 *   POST /webhook/github    — Receive GitHub webhook events
 *   POST /tasks             — Manually create a task
 *   POST /tasks/:id/start   — Start pipeline for an existing task
 *   GET  /health            — Health check
 *   GET  /tasks             — List pending tasks
 */
export async function startServer(caseRoot: string, config: ServerConfig): Promise<void> {
  const repos = await loadProjects(caseRoot);
  const pendingTasks: TaskCreateRequest[] = [];

  // Start scanners
  const stopScanners = startScanners(caseRoot, repos, config.scanners, (tasks) => {
    for (const task of tasks) {
      log.info('scanner created task', { repo: task.repo, title: task.title });
      pendingTasks.push(task);
    }
  });

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(req) {
      try {
        return await handleRequest(req, caseRoot, config, repos, pendingTasks);
      } catch (err) {
        log.error('request error', { error: String(err) });
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    },
  });

  log.info('server started', { port: server.port, hostname: server.hostname });
  process.stdout.write(`Case orchestrator listening on http://${server.hostname}:${server.port}\n`);

  // Graceful shutdown
  const shutdown = () => {
    log.info('shutting down');
    stopScanners();
    server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleRequest(
  req: Request,
  caseRoot: string,
  config: ServerConfig,
  repos: ProjectEntry[],
  pendingTasks: TaskCreateRequest[],
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', uptime: process.uptime() });
  }

  if (method === 'GET' && url.pathname === '/tasks') {
    return Response.json({
      pending: pendingTasks.map((t) => ({
        repo: t.repo,
        title: t.title,
        trigger: t.trigger.type,
      })),
    });
  }

  if (method === 'POST' && url.pathname === '/webhook/github') {
    return handleGitHubWebhook(req, caseRoot, config, pendingTasks);
  }

  if (method === 'POST' && url.pathname === '/tasks') {
    return handleCreateTask(req, caseRoot);
  }

  const startMatch = url.pathname.match(/^\/tasks\/(\d+)\/start$/);
  if (method === 'POST' && startMatch) {
    const idx = parseInt(startMatch[1], 10);
    return handleStartTask(idx, caseRoot, pendingTasks);
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

async function handleGitHubWebhook(
  req: Request,
  caseRoot: string,
  config: ServerConfig,
  pendingTasks: TaskCreateRequest[],
): Promise<Response> {
  const body = await req.text();

  if (config.webhookSecret) {
    const signature = req.headers.get('x-hub-signature-256') ?? undefined;
    if (!(await verifyWebhookSignature(body, signature, config.webhookSecret))) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  const eventType = req.headers.get('x-github-event');
  const deliveryId = req.headers.get('x-github-delivery') ?? 'unknown';

  if (!eventType) {
    return Response.json({ error: 'Missing X-GitHub-Event header' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const task = parseGitHubEvent(eventType, deliveryId, payload);
  if (task) {
    if (task.autoStart) {
      const created = await createTask(caseRoot, task);
      dispatchPipeline(caseRoot, created.taskJsonPath).catch((err) => {
        log.error('auto-start pipeline failed', { error: String(err) });
      });
      return Response.json({ action: 'created_and_started', taskId: created.taskId }, { status: 201 });
    }
    pendingTasks.push(task);
    return Response.json({ action: 'queued', repo: task.repo, title: task.title }, { status: 201 });
  }

  return Response.json({ action: 'ignored' });
}

async function handleCreateTask(req: Request, caseRoot: string): Promise<Response> {
  let request: TaskCreateRequest;
  try {
    request = (await req.json()) as TaskCreateRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!request.repo || !request.title || !request.description) {
    return Response.json({ error: 'Missing required fields: repo, title, description' }, { status: 400 });
  }

  if (!request.trigger) {
    request.trigger = { type: 'manual', description: 'Created via API' };
  }

  let created;
  try {
    created = await createTask(caseRoot, request);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return Response.json({ taskId: created.taskId, path: created.taskJsonPath }, { status: 201 });
}

async function handleStartTask(idx: number, caseRoot: string, pendingTasks: TaskCreateRequest[]): Promise<Response> {
  if (idx < 0 || idx >= pendingTasks.length) {
    return Response.json({ error: 'Task index out of range' }, { status: 404 });
  }

  const request = pendingTasks.splice(idx, 1)[0];

  let created;
  try {
    created = await createTask(caseRoot, request);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  dispatchPipeline(caseRoot, created.taskJsonPath).catch((err) => {
    log.error('pipeline dispatch failed', { taskId: created.taskId, error: String(err) });
  });

  return Response.json({ action: 'started', taskId: created.taskId });
}

async function dispatchPipeline(caseRoot: string, taskJsonPath: string): Promise<void> {
  const config = await buildPipelineConfig({
    taskJsonPath,
    mode: 'unattended',
  });
  await runPipeline(config);
}
