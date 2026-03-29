import type { ApprovalEvidence } from '../types.js';

/**
 * Render the approval gate page as a complete HTML string.
 * All CSS and JS are inlined — no external dependencies.
 */
export function renderApprovalPage(evidence: ApprovalEvidence, serverPort: number): string {
  const { task, diff, tests, verifier, reviewer, screenshots, commit } = evidence;
  const apiBase = `http://localhost:${serverPort}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Case Approval Gate · ${escapeHtml(task.title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<header>
  <h1>Case Approval Gate</h1>
  <div class="task-meta">
    <span class="badge">${escapeHtml(task.repo)}</span>
    <span class="task-title">${escapeHtml(task.title)}</span>
    ${task.issue ? `<span class="badge badge-muted">${escapeHtml(task.issue)}</span>` : ''}
    ${commit ? `<code class="commit">${escapeHtml(commit.slice(0, 8))}</code>` : ''}
  </div>
</header>

<div class="layout">
  <aside class="sidebar">
    <h2>Files <span class="count">${diff.files.length}</span></h2>
    <div class="stat-line">+${diff.summary.additions} −${diff.summary.deletions}</div>
    <ul class="file-list">
      ${diff.files.map((f, i) => `<li>
        <a href="#file-${i}" class="file-link">
          <span class="file-status file-status-${f.status}">${fileStatusIcon(f.status)}</span>
          <span class="file-path">${escapeHtml(f.path)}</span>
          <span class="file-stats">+${f.additions} −${f.deletions}</span>
        </a>
      </li>`).join('\n      ')}
    </ul>
  </aside>

  <main>
    <section class="diff-view">
      <h2>Diff</h2>
      ${diff.files.length === 0
        ? '<p class="empty">No changes detected</p>'
        : diff.files.map((f, i) => `
        <div class="diff-file" id="file-${i}">
          <div class="diff-file-header">
            <span class="file-status file-status-${f.status}">${fileStatusIcon(f.status)}</span>
            ${escapeHtml(f.path)}
            <span class="file-stats">+${f.additions} −${f.deletions}</span>
          </div>
          ${f.hunks.length === 0
            ? '<div class="diff-hunk"><pre class="diff-content"><span class="diff-binary">Binary file</span></pre></div>'
            : f.hunks.map(h => `
          <div class="diff-hunk">
            <div class="hunk-header">${escapeHtml(h.header)}</div>
            <pre class="diff-content">${renderHunkLines(h.lines, f.path)}</pre>
          </div>`).join('')}
        </div>`).join('')}
    </section>

    <section class="evidence">
      <h2>Evidence</h2>
      <div class="evidence-cards">
        <div class="card ${tests.passed === true ? 'card-pass' : tests.passed === false ? 'card-fail' : 'card-na'}">
          <div class="card-title">Tests</div>
          <div class="card-value">${tests.passed === true ? 'Passed' : tests.passed === false ? 'Failed' : 'N/A'}</div>
        </div>
        ${renderVerifierCard(verifier)}
        ${renderReviewerCard(reviewer)}
      </div>

      ${verifier.ran && verifier.rubric ? renderRubricDetail('Verifier Rubric', verifier.rubric) : ''}
      ${reviewer.ran && reviewer.rubric ? renderRubricDetail('Reviewer Rubric', reviewer.rubric) : ''}
      ${reviewer.ran && reviewer.findings ? renderFindingsDetail(reviewer.findings) : ''}
    </section>

    ${screenshots.length > 0 ? `
    <section class="screenshots">
      <h2>Screenshots</h2>
      <div class="screenshot-gallery">
        ${screenshots.map((s, i) => {
          const filename = s.split('/').pop() ?? s;
          return `<div class="screenshot-thumb" onclick="expandScreenshot(${i})">
            <img src="${apiBase}/screenshots/${encodeURIComponent(filename)}" alt="${escapeHtml(filename)}" loading="lazy">
            <span class="screenshot-name">${escapeHtml(filename)}</span>
          </div>`;
        }).join('\n        ')}
      </div>
      <div id="screenshot-modal" class="modal" onclick="this.classList.remove('active')">
        <img id="screenshot-modal-img" src="" alt="Screenshot">
      </div>
    </section>` : ''}
  </main>
</div>

<footer>
  <div class="actions">
    <button class="btn btn-approve" onclick="submitDecision('approve')">Approve</button>
    <button class="btn btn-revise" onclick="toggleRevisePanel()">Request Changes</button>
    <button class="btn btn-reject" onclick="submitDecision('reject')">Reject</button>
  </div>
  <div id="revise-panel" class="revise-panel hidden">
    <textarea id="feedback" placeholder="Describe what needs changing..." rows="4"></textarea>
    <label class="toggle-label">
      <input type="checkbox" id="manual-edit"> I'll edit manually
    </label>
    <button class="btn btn-revise-submit" onclick="submitRevision()">Submit Feedback</button>
  </div>
  <div id="status-message" class="status-message hidden"></div>
  <div id="manual-edit-panel" class="manual-edit-panel hidden">
    <p>Editing mode &mdash; make your changes in your editor, then click Ready.</p>
    <button class="btn btn-approve" onclick="signalReady()">Ready</button>
  </div>
</footer>

<script>
${JS(apiBase)}
</script>
</body>
</html>`;
}

// --- Helpers ---

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileStatusIcon(status: string): string {
  switch (status) {
    case 'added': return '+';
    case 'deleted': return '−';
    case 'renamed': return '→';
    default: return '●';
  }
}

function renderHunkLines(lines: string[], filePath: string): string {
  const isHighlightable = /\.(ts|tsx|js|jsx)$/.test(filePath);

  return lines.map(line => {
    const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    const content = escapeHtml(line);
    const highlighted = isHighlightable ? tokenize(content) : content;
    return `<span class="diff-line diff-${type}">${highlighted}</span>`;
  }).join('\n');
}

function tokenize(escapedLine: string): string {
  // CSS-based token coloring for TS/JS — applied to already-escaped HTML
  return escapedLine
    // Strings (single, double, template)
    .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="tok-string">$1</span>')
    // Comments
    .replace(/(\/\/.*)$/, '<span class="tok-comment">$1</span>')
    // Keywords
    .replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|implements|interface|type|async|await|throw|try|catch|finally|default|typeof|instanceof)\b/g, '<span class="tok-keyword">$1</span>')
    // Types (capitalized words after : or as, or common TS types)
    .replace(/\b(string|number|boolean|void|null|undefined|never|any|unknown|Promise|Array|Map|Set|Record|Partial)\b/g, '<span class="tok-type">$1</span>')
    // Numbers
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-number">$1</span>');
}

function renderVerifierCard(v: ApprovalEvidence['verifier']): string {
  if (!v.ran) return '<div class="card card-na"><div class="card-title">Verifier</div><div class="card-value">Skipped</div></div>';
  const total = v.rubric?.length ?? 0;
  const passed = v.rubric?.filter(c => c.verdict === 'pass').length ?? 0;
  const allPass = passed === total;
  return `<div class="card ${allPass ? 'card-pass' : 'card-fail'}">
    <div class="card-title">Verifier</div>
    <div class="card-value">${passed}/${total} pass</div>
  </div>`;
}

function renderReviewerCard(r: ApprovalEvidence['reviewer']): string {
  if (!r.ran) return '<div class="card card-na"><div class="card-title">Reviewer</div><div class="card-value">N/A</div></div>';
  if (r.findings) {
    const hasIssues = r.findings.critical > 0;
    return `<div class="card ${hasIssues ? 'card-fail' : 'card-pass'}">
      <div class="card-title">Reviewer</div>
      <div class="card-value">${r.findings.critical} crit, ${r.findings.warnings} warn</div>
    </div>`;
  }
  const total = r.rubric?.length ?? 0;
  const passed = r.rubric?.filter(c => c.verdict === 'pass').length ?? 0;
  return `<div class="card ${passed === total ? 'card-pass' : 'card-fail'}">
    <div class="card-title">Reviewer</div>
    <div class="card-value">${passed}/${total} pass</div>
  </div>`;
}

function renderRubricDetail(title: string, categories: Array<{ category: string; verdict: string; detail: string }>): string {
  return `<details class="rubric-detail">
    <summary>${escapeHtml(title)}</summary>
    <div class="rubric-categories">
      ${categories.map(c => `<div class="rubric-cat rubric-${c.verdict}">
        <span class="rubric-verdict">${c.verdict.toUpperCase()}</span>
        <span class="rubric-name">${escapeHtml(c.category)}</span>
        <span class="rubric-text">${escapeHtml(c.detail)}</span>
      </div>`).join('\n      ')}
    </div>
  </details>`;
}

function renderFindingsDetail(findings: NonNullable<ApprovalEvidence['reviewer']['findings']>): string {
  if (findings.details.length === 0 && findings.critical === 0 && findings.warnings === 0 && findings.info === 0) {
    return '';
  }

  const grouped = { critical: [] as typeof findings.details, warning: [] as typeof findings.details, info: [] as typeof findings.details };
  for (const d of findings.details) {
    const key = d.severity === 'critical' ? 'critical' : d.severity === 'warning' ? 'warning' : 'info';
    grouped[key].push(d);
  }

  return `<details class="findings-detail">
    <summary>Review Findings (${findings.critical} critical, ${findings.warnings} warnings, ${findings.info} info)</summary>
    ${(['critical', 'warning', 'info'] as const).map(sev => {
      if (grouped[sev].length === 0) return '';
      return `<div class="findings-group">
        <h4 class="findings-severity findings-${sev}">${sev}</h4>
        ${grouped[sev].map(d => `<div class="finding">
          <div class="finding-header">${escapeHtml(d.principle)} · ${escapeHtml(d.file)}${d.line ? `:${d.line}` : ''}</div>
          <div class="finding-message">${escapeHtml(d.message)}</div>
        </div>`).join('')}
      </div>`;
    }).join('')}
  </details>`;
}

// --- Inlined CSS ---

const CSS = `
:root {
  --bg: #1a1b26; --bg-surface: #24283b; --bg-highlight: #292e42;
  --fg: #c0caf5; --fg-muted: #565f89; --fg-bright: #a9b1d6;
  --green: #9ece6a; --red: #f7768e; --yellow: #e0af68; --blue: #7aa2f7;
  --orange: #ff9e64; --purple: #bb9af7; --cyan: #7dcfff;
  --border: #3b4261; --radius: 6px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, 'SF Mono', 'Fira Code', monospace; background: var(--bg); color: var(--fg); min-height: 100vh; display: flex; flex-direction: column; }
header { padding: 16px 24px; border-bottom: 1px solid var(--border); }
header h1 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--fg-muted); margin-bottom: 8px; }
.task-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.task-title { font-size: 18px; font-weight: 600; }
.badge { background: var(--blue); color: var(--bg); padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
.badge-muted { background: var(--bg-highlight); color: var(--fg-muted); }
.commit { background: var(--bg-highlight); padding: 2px 6px; border-radius: 3px; font-size: 12px; color: var(--fg-muted); }

.layout { display: flex; flex: 1; overflow: hidden; }
.sidebar { width: 280px; min-width: 200px; border-right: 1px solid var(--border); overflow-y: auto; padding: 16px; flex-shrink: 0; }
.sidebar h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--fg-muted); margin-bottom: 8px; }
.sidebar .count { color: var(--fg-bright); }
.stat-line { font-size: 12px; color: var(--fg-muted); margin-bottom: 12px; }
.file-list { list-style: none; }
.file-list li { margin-bottom: 2px; }
.file-link { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: var(--radius); text-decoration: none; color: var(--fg); font-size: 13px; }
.file-link:hover { background: var(--bg-highlight); }
.file-status { width: 16px; text-align: center; font-weight: 700; }
.file-status-added { color: var(--green); }
.file-status-deleted { color: var(--red); }
.file-status-modified { color: var(--yellow); }
.file-status-renamed { color: var(--blue); }
.file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-stats { color: var(--fg-muted); font-size: 11px; white-space: nowrap; }

main { flex: 1; overflow-y: auto; padding: 24px; padding-bottom: 120px; }
main h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: var(--fg-muted); margin-bottom: 16px; }
.empty { color: var(--fg-muted); font-style: italic; }

.diff-file { margin-bottom: 24px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.diff-file-header { padding: 8px 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border); font-size: 13px; display: flex; align-items: center; gap: 8px; }
.hunk-header { padding: 4px 12px; background: var(--bg-highlight); color: var(--fg-muted); font-size: 12px; border-bottom: 1px solid var(--border); }
.diff-content { padding: 0; margin: 0; font-size: 13px; line-height: 1.5; overflow-x: auto; }
.diff-line { display: block; padding: 0 12px; white-space: pre; }
.diff-add { background: rgba(158, 206, 106, 0.1); color: var(--green); }
.diff-del { background: rgba(247, 118, 142, 0.1); color: var(--red); }
.diff-ctx { color: var(--fg-muted); }
.diff-binary { color: var(--fg-muted); font-style: italic; padding: 8px 12px; display: block; }

.tok-keyword { color: var(--purple); }
.tok-string { color: var(--green); }
.tok-comment { color: var(--fg-muted); font-style: italic; }
.tok-type { color: var(--cyan); }
.tok-number { color: var(--orange); }

.evidence { margin-top: 32px; }
.evidence-cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.card { padding: 16px; border-radius: var(--radius); min-width: 140px; border: 1px solid var(--border); }
.card-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
.card-value { font-size: 18px; font-weight: 600; }
.card-pass { background: rgba(158, 206, 106, 0.1); border-color: var(--green); }
.card-pass .card-value { color: var(--green); }
.card-fail { background: rgba(247, 118, 142, 0.1); border-color: var(--red); }
.card-fail .card-value { color: var(--red); }
.card-na { background: var(--bg-surface); }
.card-na .card-value { color: var(--fg-muted); }

details { margin-bottom: 12px; }
summary { cursor: pointer; padding: 8px 12px; background: var(--bg-surface); border-radius: var(--radius); font-size: 13px; }
summary:hover { background: var(--bg-highlight); }
.rubric-categories { padding: 8px; }
.rubric-cat { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 4px; font-size: 13px; }
.rubric-verdict { font-weight: 700; width: 40px; text-align: center; font-size: 11px; }
.rubric-pass .rubric-verdict { color: var(--green); }
.rubric-fail .rubric-verdict { color: var(--red); }
.rubric-na .rubric-verdict { color: var(--fg-muted); }
.rubric-name { font-weight: 500; min-width: 180px; }
.rubric-text { color: var(--fg-muted); }

.findings-group { margin: 8px; }
.findings-severity { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; padding: 4px 0; }
.findings-critical { color: var(--red); }
.findings-warning { color: var(--yellow); }
.findings-info { color: var(--blue); }
.finding { padding: 8px; border-left: 3px solid var(--border); margin: 4px 0; }
.finding-header { font-size: 12px; color: var(--fg-muted); margin-bottom: 4px; }
.finding-message { font-size: 13px; }

.screenshots { margin-top: 32px; }
.screenshot-gallery { display: flex; gap: 12px; flex-wrap: wrap; }
.screenshot-thumb { cursor: pointer; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; width: 200px; }
.screenshot-thumb img { width: 100%; height: 140px; object-fit: cover; }
.screenshot-name { display: block; padding: 4px 8px; font-size: 11px; color: var(--fg-muted); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 100; }
.modal.active { display: flex; }
.modal img { max-width: 90vw; max-height: 90vh; border-radius: var(--radius); }

footer { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg-surface); border-top: 1px solid var(--border); padding: 12px 24px; z-index: 50; }
.actions { display: flex; gap: 12px; justify-content: center; }
.btn { padding: 8px 24px; border: none; border-radius: var(--radius); font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-approve { background: var(--green); color: var(--bg); }
.btn-approve:hover:not(:disabled) { filter: brightness(1.1); }
.btn-revise { background: var(--yellow); color: var(--bg); }
.btn-revise:hover:not(:disabled) { filter: brightness(1.1); }
.btn-reject { background: var(--red); color: var(--bg); }
.btn-reject:hover:not(:disabled) { filter: brightness(1.1); }
.btn-revise-submit { background: var(--blue); color: var(--bg); }

.revise-panel { margin-top: 12px; }
.revise-panel textarea { width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; font-family: inherit; font-size: 13px; resize: vertical; }
.toggle-label { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 13px; cursor: pointer; }
.hidden { display: none !important; }
.status-message { margin-top: 8px; text-align: center; font-size: 13px; }
.status-message.success { color: var(--green); }
.status-message.error { color: var(--red); }
.manual-edit-panel { margin-top: 12px; text-align: center; }
.manual-edit-panel p { margin-bottom: 8px; color: var(--yellow); font-size: 14px; }
`;

// --- Inlined JS ---

function JS(apiBase: string): string {
  return `
const API = '${apiBase}';
let submitted = false;

function submitDecision(decision) {
  if (submitted) return;
  if (decision === 'reject' && !confirm('Reject this work? The pipeline will abort.')) return;
  send({ decision });
}

function toggleRevisePanel() {
  document.getElementById('revise-panel').classList.toggle('hidden');
}

function submitRevision() {
  if (submitted) return;
  const feedback = document.getElementById('feedback').value.trim() || 'No feedback provided';
  const manualEdit = document.getElementById('manual-edit').checked;
  send({ decision: 'revise', feedback, manualEdit });
}

function expandScreenshot(idx) {
  const thumbs = document.querySelectorAll('.screenshot-thumb img');
  if (thumbs[idx]) {
    document.getElementById('screenshot-modal-img').src = thumbs[idx].src;
    document.getElementById('screenshot-modal').classList.add('active');
  }
}

async function send(body) {
  submitted = true;
  const btns = document.querySelectorAll('.btn');
  btns.forEach(b => b.disabled = true);

  const statusEl = document.getElementById('status-message');
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.textContent = 'Submitting...';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + '/api/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.waitForReady) {
          // Manual edit mode — show waiting state
          document.querySelector('.actions').classList.add('hidden');
          document.getElementById('revise-panel').classList.add('hidden');
          statusEl.classList.add('hidden');
          document.getElementById('manual-edit-panel').classList.remove('hidden');
          submitted = false; // allow Ready button to work
          return;
        }
        statusEl.textContent = 'Decision submitted. You can close this tab.';
        statusEl.classList.add('success');
        return;
      }
    } catch (e) {
      if (attempt < 2) continue;
    }
  }

  statusEl.textContent = 'Failed to submit. Check the terminal.';
  statusEl.classList.add('error');
  submitted = false;
  btns.forEach(b => b.disabled = false);
}

async function signalReady() {
  if (submitted) return;
  submitted = true;
  const panel = document.getElementById('manual-edit-panel');
  const readyBtn = panel.querySelector('.btn');
  readyBtn.disabled = true;

  const statusEl = document.getElementById('status-message');
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.textContent = 'Signaling ready...';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + '/api/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        panel.classList.add('hidden');
        statusEl.textContent = 'Ready signal sent. Pipeline resuming. You can close this tab.';
        statusEl.classList.add('success');
        return;
      }
    } catch (e) {
      if (attempt < 2) continue;
    }
  }

  statusEl.textContent = 'Failed to signal ready. Check the terminal.';
  statusEl.classList.add('error');
  submitted = false;
  readyBtn.disabled = false;
}
`;
}
