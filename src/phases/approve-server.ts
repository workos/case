import { resolve, basename } from 'node:path';
import type { ApprovalEvidence, ApprovalDecision } from '../types.js';
import { renderApprovalPage } from './approve-ui.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Start a transient HTTP server that serves the approval UI and waits
 * for the user's decision. Returns a Promise that resolves when the
 * user submits a decision via the web UI.
 */
export async function runApprovalServer(
  evidence: ApprovalEvidence,
): Promise<ApprovalDecision> {
  let resolveDecision: (d: ApprovalDecision) => void;
  const decisionPromise = new Promise<ApprovalDecision>((res) => {
    resolveDecision = res;
  });

  // Second promise for manual edit mode — resolved when /api/ready is hit
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((res) => {
    resolveReady = res;
  });
  let waitingForReady = false;

  // Validate screenshot paths are absolute and within allowed directories
  const validScreenshots = new Set(
    evidence.screenshots.filter((p) => resolve(p) === p),
  );

  const server = Bun.serve({
    port: 0, // OS assigns available port
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }

      // Approval page
      if (req.method === 'GET' && url.pathname.startsWith('/approve/')) {
        const html = renderApprovalPage(evidence, server.port ?? 0);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Screenshot serving — validate path to prevent traversal
      if (req.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
        const filename = decodeURIComponent(url.pathname.slice('/screenshots/'.length));
        const match = [...validScreenshots].find((p) => basename(p) === filename);
        if (!match) {
          return Response.json({ error: 'Not found' }, { status: 404 });
        }
        const file = Bun.file(match);
        if (!(await file.exists())) {
          return Response.json({ error: 'Screenshot unavailable' }, { status: 404 });
        }
        return new Response(file);
      }

      // Decision endpoint
      if (req.method === 'POST' && url.pathname === '/api/decide') {
        try {
          const body = (await req.json()) as ApprovalDecision;
          if (!body.decision || !['approve', 'revise', 'reject'].includes(body.decision)) {
            return Response.json({ error: 'Invalid decision' }, { status: 400 });
          }
          log.phase('approve', `decision: ${body.decision}`);
          resolveDecision!(body);
          // Tell the UI whether to wait for /api/ready
          return Response.json({ status: 'accepted', waitForReady: !!body.manualEdit });
        } catch {
          return Response.json({ error: 'Invalid JSON' }, { status: 400 });
        }
      }

      // Ready endpoint — signals manual edit is complete
      if (req.method === 'POST' && url.pathname === '/api/ready') {
        if (!waitingForReady) {
          return Response.json({ error: 'Not in manual edit mode' }, { status: 409 });
        }
        log.phase('approve', 'manual edit ready signal received');
        resolveReady!();
        return Response.json({ status: 'accepted' });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });

  const approveUrl = `http://localhost:${server.port}/approve/${evidence.task.id}`;
  log.phase('approve', `server started on port ${server.port}`);
  process.stdout.write(`\nApproval gate: ${approveUrl}\n`);

  // Open browser (macOS)
  try {
    Bun.spawn(['open', approveUrl]);
  } catch {
    log.phase('approve', 'failed to open browser — navigate manually');
  }

  // Wait for decision
  const decision = await decisionPromise;

  // Manual edit: keep server alive until /api/ready
  if (decision.manualEdit) {
    waitingForReady = true;
    log.phase('approve', 'manual-edit-mode — waiting for ready signal');
    await readyPromise;
  }

  server.stop();
  log.phase('approve', 'server stopped');

  return decision;
}
