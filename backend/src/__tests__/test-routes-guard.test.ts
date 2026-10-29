import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import { assertNoTestRoutesInProduction } from '../lib/test-routes-guard';

describe('assertNoTestRoutesInProduction', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws when NODE_ENV=production and a /api/test/* route is registered', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = express();
    app.post('/api/test/cleanup', (_req, res) => res.json({}));

    expect(() => assertNoTestRoutesInProduction(app))
      .toThrow(/test.+route.+production/i);
  });

  it('throws if any one of multiple test routes is present in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = express();
    app.get('/api/healthy', (_req, res) => res.json({}));
    app.post('/api/test/expire-estimates', (_req, res) => res.json({}));

    expect(() => assertNoTestRoutesInProduction(app)).toThrow();
  });

  it('no-ops when NODE_ENV=production and no test routes exist', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = express();
    app.get('/api/healthy', (_req, res) => res.json({}));

    expect(() => assertNoTestRoutesInProduction(app)).not.toThrow();
  });

  it('no-ops when NODE_ENV is not production, even if test routes exist', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = express();
    app.post('/api/test/cleanup', (_req, res) => res.json({}));

    expect(() => assertNoTestRoutesInProduction(app)).not.toThrow();
  });
});
