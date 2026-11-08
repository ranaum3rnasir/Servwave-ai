import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

// Guards F-57: the codex MCP config (.codex/config.toml holds a LIVE RESEND_API_KEY) and
// any auth-token files must NEVER be tracked by git. If someone `git add`s them, this fails
// loudly in CI. Runs from the repo root (not the backend cwd) so the root-level .codex/ is
// actually checked.
describe('codex/auth token files are never committed (F-57)', () => {
  it('has no .codex/ or auth-token files tracked by git', () => {
    const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const tracked = execSync('git ls-files .codex/ auth.json codex-auth.json', {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });
});
