// Nightly full run of staging (#3256): the rules, as pure functions. collect.mjs and write.mjs are the thin I/O around them.
// No imports on purpose: the report job runs this file without installing anything.

/** A hidden marker in every issue body: it is how the one open issue is found again. */
export const MARKER = '<!-- ci-nightly-staging -->';
/** One priority, one module (docs/agents/issue-tracker.md) and the label the job looks its issue up by. */
export const ISSUE_LABELS = ['priority:medium', 'module:general', 'ci-nightly'];
export const ISSUE_TITLE = 'CI nightly: the full run of staging is red';
export const STAGING = 'staging';
/** A ref for the visible text, inside a code span: the one character that could end the span is dropped. */
export const safeRef = (r) => String(r).replace(/`/g, '');

/**
 * The branch name behind the two spellings of the staging branch GitHub gives a checkout input: `staging` and `refs/heads/staging`
 * (the `refs/heads/` prefix in any letter case). Nothing else is rewritten: a branch literally named `origin/staging` or `heads/staging`
 * is a different branch and never counts as staging.
 */
export function normalizeRef(text) {
  const r = String(text ?? '').trim();
  const m = /^refs\/heads\/(.+)$/i.exec(r);
  return m ? m[1] : r;
}

/**
 * True for every name `git check-ref-format --branch` accepts (pinned against the real command in the tests). Markup characters are
 * allowed here and made harmless where the name is printed (safeRef, and the JSON escaping of the hidden state).
 */
export function isValidRef(name) {
  if (typeof name !== 'string' || name === '' || name.length > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (/^[-/]|[/.]$|(^|\/)\.|\.lock(\/|$)/.test(name) || name === '@') return false;
  return true;
}

/** User-controlled text (a test file name, a verdict line) made harmless inside an issue body: one line, no HTML comment markers. */
export const neutralize = (t) => String(t).replace(/\s+/g, ' ').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
export const FAILED_FILES_SHOWN = 40;

export function formatDuration(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** The last TEST-CI-VERDICT line of a log, read into fields; null when the log has none. */
export function parseVerdictLine(log) {
  const lines = String(log).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('TEST-CI-VERDICT '));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const f = Object.fromEntries(line.split(' ').slice(1).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  return {
    line, result: f.result, code: Number(f.code), reasons: f.reasons === 'none' ? [] : String(f.reasons).split(','),
    mode: f.mode, files: f.files, passed: Number(f.passed), failed: Number(f.failed), retried: Number(f.retried),
  };
}

/** Test files named by the "failed so far" lines (FAILED <file> > ..., FAILED <file> (file): ...), each once, first-seen order. */
export function failedFilesFromLines(lines) {
  const seen = new Set();
  for (const l of lines) {
    const m = /^FAILED (\S+)(?: > | \((?:file|suite)\):)/.exec(l);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}

/** The "Budget" figures table out of the run's markdown summary, or null. */
export function budgetSection(summaryMd) {
  const lines = String(summaryMd ?? '').split('\n');
  const at = lines.findIndex((l) => l.trim() === '### Budget');
  if (at < 0) return null;
  const out = [];
  for (let i = at + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i += 1) out.push(lines[i]);
  const text = out.join('\n').trim();
  return text || null;
}

const lineStarting = (log, prefix) => String(log).split('\n').map((l) => l.trim()).filter((l) => l.startsWith(prefix)).pop() ?? null;

/** Everything the report job needs, as plain JSON. Built in the run job, from what the one command printed and wrote. */
export function buildReport({ ref, sha, exitCode, log, failedLines, summaryMd, runSeconds }) {
  const all = failedFilesFromLines(failedLines ?? []);
  return {
    ref, sha, exitCode, runSeconds,
    verdictLine: parseVerdictLine(log)?.line ?? null,
    brakeLine: lineStarting(log, 'TEST-BRAKE-VERDICT '),
    failedFiles: all.slice(0, FAILED_FILES_SHOWN),
    failedMore: Math.max(0, all.length - FAILED_FILES_SHOWN),
    budget: budgetSection(summaryMd),
  };
}

/**
 * green | red. Only a full run that exited 0 with a passed verdict is green; everything else is red (D11), a cancelled or
 * timed-out run included: a night nobody proved green must never read as green. `jobResult` is the run job's own result.
 */
export function classify(report, jobResult) {
  if (!report) {
    return { color: 'red', reason: jobResult === 'cancelled' ? 'the run was cancelled or timed out before it produced a report' : 'the run failed before it produced a report' };
  }
  const v = parseVerdictLine(report.verdictLine ?? '');
  if (!v) return { color: 'red', reason: `exit code ${report.exitCode}, no verdict line` };
  if (report.exitCode === 0 && v.result === 'passed' && v.mode === 'full') return { color: 'green' };
  if (report.exitCode === 0 && v.result === 'passed') return { color: 'red', reason: `exit code 0 but not a full run (mode=${v.mode})` };
  return { color: 'red', reason: `exit code ${report.exitCode}, verdict ${v.result} (${v.reasons.join(', ') || 'none'})` };
}

function bodyOf(report, why, runUrl, ref) {
  const out = [`The full Frontend run of \`${safeRef(ref)}\` (nightly) is red: ${neutralize(why)}.`, ''];
  if (runUrl) out.push(`Run: ${runUrl}`);
  if (report) {
    out.push(`Commit: \`${report.sha}\`. Run time: ${formatDuration(report.runSeconds)}.`, '', '```');
    if (report.verdictLine) out.push(neutralize(report.verdictLine));
    if (report.brakeLine) out.push(neutralize(report.brakeLine));
    out.push('```', '');
    if (report.failedFiles.length) {
      out.push('Failed files:', '', ...report.failedFiles.map((f) => `- ${neutralize(f)}`));
      if (report.failedMore) out.push(`- and ${report.failedMore} more (see the run)`);
      out.push('');
    }
    if (report.budget) out.push('Budget figures:', '', report.budget.replace(/<!--/g, '&lt;!--'), '');
  }
  out.push('Staging stays open for merges: this alerts, it does not block. Read this issue before promoting to main.', '');
  return out.join('\n');
}

// The state block is the one we write: right before the closing MARKER, at the very end of the body. Text a run can influence
// (file names, reasons) comes earlier and is neutralized, so only this position is ever read.
const STATE_RE = /<!-- ci-nightly-state (\{[^\n]*?\}) -->\n<!-- ci-nightly-staging -->\s*$/;
const STATE_ANY_RE = /<!-- ci-nightly-state \{[^\n]*?\} -->\n?/g;
const REFS_LINE_RE = /^Refs that were red: .*$/m;


/**
 * Which refs have been red while the issue was open, and which ref opened it. Lives in the issue body (a hidden JSON marker plus a
 * visible line). An issue without it (older body) reads as opened by staging and red on staging: the safest reading.
 */
export function stateOf(body) {
  const m = STATE_RE.exec(body ?? '');
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      return { openedBy: String(j.openedBy), refs: j.refs.map(String), stagingRed: Boolean(j.stagingRed) };
    } catch { /* fall through to the safe reading */ }
  }
  return { openedBy: STAGING, refs: [STAGING], stagingRed: true };
}

const stateBlock = (st) => {
  const json = JSON.stringify(st).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `Refs that were red: ${st.refs.map((r) => `\`${safeRef(r)}\``).join(', ')}. Opened by a run of \`${safeRef(st.openedBy)}\`.\n<!-- ci-nightly-state ${json} -->`;
};

/** The issue body with its state replaced (or added right before the marker). */
function withState(body, st) {
  const cleaned = body.replace(REFS_LINE_RE, '').replace(STATE_ANY_RE, '').replace(/\n{3,}/g, '\n\n');
  return cleaned.includes(MARKER) ? cleaned.replace(MARKER, `${stateBlock(st)}\n${MARKER}`) : `${cleaned}\n${stateBlock(st)}\n${MARKER}\n`;
}

/**
 * What to do with a finished run of `ref`: open the one issue, comment on the open one (and record the ref in its body), close the
 * open ones that this run may close, or nothing. Open issues are found by MARKER (a pull request never matches); with two marked
 * issues open the oldest gets the comment.
 *
 * Any ref may open or update the issue when red (a drill on a throwaway branch). A green run closes an issue only when it is a full
 * run (classify) AND its ref is staging, OR its ref is the ref that opened that issue and no staging run has been red since: a green
 * throwaway branch can close only its own drill issue, never a real staging failure.
 */
export function decide({ report, jobResult, openIssues, runUrl, ref: given }) {
  // Every spelling of a branch is reduced to its name first; a name git would not accept (or that carries markup) touches nothing.
  const ref = normalizeRef(given);
  if (!isValidRef(ref)) return { kind: 'none', why: `the ref ${JSON.stringify(neutralize(String(given).slice(0, 80)))} is not a valid branch name, so the issue is left alone` };
  const verdict = classify(report, jobResult);
  const marked = openIssues.filter((i) => !i.pull_request && (i.body ?? '').includes(MARKER)).sort((a, b) => a.number - b.number);
  if (verdict.color === 'green') {
    const closable = marked.filter((i) => ref === STAGING || (ref === stateOf(i.body).openedBy && !stateOf(i.body).stagingRed));
    if (closable.length === 0) {
      return { kind: 'none', why: marked.length === 0 ? 'green, and no nightly issue is open' : `green run of ${ref}: it may not close the open issue (it was not opened by this ref, or staging has been red since)` };
    }
    const lines = [`The full run of \`${safeRef(ref)}\` is green again.`, ''];
    if (runUrl) lines.push(`Run: ${runUrl}`);
    lines.push(`Commit: \`${report.sha}\`. Run time: ${formatDuration(report.runSeconds)}.`, '', '```', neutralize(report.verdictLine), '```', '', 'Closing.', '');
    return { kind: 'close', numbers: closable.map((i) => i.number), body: lines.join('\n') };
  }
  const body = `${bodyOf(report, verdict.reason, runUrl, ref)}\n${MARKER}\n`;
  if (marked.length === 0) {
    const st = { openedBy: ref, refs: [ref], stagingRed: ref === STAGING };
    return { kind: 'open', title: ISSUE_TITLE, labels: ISSUE_LABELS, body: withState(body, st) };
  }
  const first = marked[0];
  const prev = stateOf(first.body);
  const st = { openedBy: prev.openedBy, refs: prev.refs.includes(ref) ? prev.refs : [...prev.refs, ref], stagingRed: prev.stagingRed || ref === STAGING };
  const others = marked.slice(1).map((i) => `#${i.number}`);
  const comment = `Red run of \`${safeRef(ref)}\`.\n\n${body}`;
  return {
    kind: 'comment', number: first.number, issueBody: withState(first.body, st),
    body: others.length ? `${comment}\nAlso open with the same marker: ${others.join(', ')}.\n` : comment,
  };
}

/** The run job's own section of the job summary (the command's budget table is shown with it). */
export function renderSummary(report) {
  const out = ['## Nightly full run', '', `Ref: \`${report.ref}\` at \`${report.sha}\`. Run time: ${formatDuration(report.runSeconds)}.`, '', '```'];
  if (report.verdictLine) out.push(neutralize(report.verdictLine));
  if (report.brakeLine) out.push(neutralize(report.brakeLine));
  out.push('```', '');
  if (report.failedFiles.length) out.push('Failed files:', '', ...report.failedFiles.map((f) => `- ${neutralize(f)}`), '');
  out.push('### Budget figures', '', report.budget ?? 'Not printed by this run.', '');
  return out.join('\n');
}
