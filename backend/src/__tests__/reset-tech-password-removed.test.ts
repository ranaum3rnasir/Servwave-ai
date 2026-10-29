import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

// Password reset slice 07 (spec §7): the dev script that set a technician's password is gone. It
// passed the app id where the auth id belongs and set a password the user did not choose. An admin
// sends a reset link from Users & Teams instead. This guards against it creeping back.
const BACKEND = path.resolve(__dirname, '../..');
const text = (rel: string) => readFileSync(path.join(BACKEND, rel), 'utf8');

describe('the technician password reset script stays removed', () => {
  it('the script is gone', () => {
    expect(existsSync(path.join(BACKEND, 'src/reset-tech-password.ts'))).toBe(false);
  });
  it('nothing in the backend config names it', () => {
    for (const file of ['tsconfig.build.json', 'tsconfig.json', 'package.json', '.env.example']) {
      if (existsSync(path.join(BACKEND, file))) expect(text(file)).not.toContain('reset-tech-password');
    }
  });
});
