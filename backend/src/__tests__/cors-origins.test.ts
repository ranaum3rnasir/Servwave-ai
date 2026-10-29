import { describe, it, expect } from 'vitest';
import { parseCorsOrigins } from '../lib/cors-origins';

describe('parseCorsOrigins', () => {
  it('returns a single-item list when only FRONTEND_URL is set', () => {
    expect(parseCorsOrigins({ FRONTEND_URL: 'http://localhost:5173' }))
      .toEqual(['http://localhost:5173']);
  });

  it('splits CORS_ALLOWED_ORIGINS on commas and trims', () => {
    expect(parseCorsOrigins({
      FRONTEND_URL: 'http://localhost:5173',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com, https://www.example.com',
    })).toEqual(['https://app.example.com', 'https://www.example.com']);
  });

  it('drops empty segments from CORS_ALLOWED_ORIGINS', () => {
    expect(parseCorsOrigins({
      FRONTEND_URL: 'http://localhost:5173',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com,,  ,https://x.com',
    })).toEqual(['https://app.example.com', 'https://x.com']);
  });

  it('prefers CORS_ALLOWED_ORIGINS over FRONTEND_URL when both are set', () => {
    expect(parseCorsOrigins({
      FRONTEND_URL: 'http://localhost:5173',
      CORS_ALLOWED_ORIGINS: 'https://prod.example.com',
    })).toEqual(['https://prod.example.com']);
  });

  it('falls back to [FRONTEND_URL] when CORS_ALLOWED_ORIGINS is empty/whitespace', () => {
    expect(parseCorsOrigins({
      FRONTEND_URL: 'http://localhost:5173',
      CORS_ALLOWED_ORIGINS: '   ',
    })).toEqual(['http://localhost:5173']);
  });
});
