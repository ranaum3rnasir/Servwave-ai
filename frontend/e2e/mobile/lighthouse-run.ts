/**
 * Runs Lighthouse (mobile) against a URL in a real Chrome, for the sweep's performance budget
 * (mobile slice 62, rubric PERF-03). The budget decision itself is pure and lives in
 * scripts/mobile-sweep-lib.mjs; this file only drives the browser.
 *
 * Lighthouse's mobile defaults are the budget's emulation: a Moto G Power sized screen, simulated
 * slow 4G and a 4x CPU slowdown (the rubric's D14 low-end Android). It is pointed at the
 * PRODUCTION build served by `vite preview`, never the dev server, whose unbundled modules say
 * nothing about what a customer downloads.
 *
 * Chrome is Playwright's own Chromium, started headless with a debugging port. A signed-in page is
 * measured by writing the session into a throwaway Chrome profile first (a Playwright persistent
 * context), then handing that profile to the measured Chrome with Lighthouse's storage reset off.
 */
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import lighthouse from 'lighthouse';
import { extractMetrics, medianMetrics } from '../../scripts/mobile-sweep-lib.mjs';

export interface LighthouseTarget {
  url: string;
  /** A localStorage entry to put in the profile first, so the page opens signed in. */
  session?: { origin: string; key: string; value: string };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDebugger(port: number, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited (${child.exitCode}) before Lighthouse could connect`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome did not open its debugging port within 30 s');
}

/** One Lighthouse navigation run. Returns the raw result (`lhr`). */
async function runOnce(target: LighthouseTarget, profileDir: string) {
  const port = await freePort();
  const chrome = spawn(
    chromium.executablePath(),
    [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', 'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    await waitForDebugger(port, chrome);
    const result = await lighthouse(target.url, {
      port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
      // The profile carries the session; a reset would sign the page out.
      disableStorageReset: !!target.session,
    });
    return result?.lhr ?? null;
  } finally {
    chrome.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Put the session into a fresh Chrome profile (a Playwright persistent context writes it). */
async function seedProfile(session: NonNullable<LighthouseTarget['session']>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, { headless: true });
  try {
    const page = await ctx.newPage();
    // Any page of the origin will do: the entry is read on the app's first boot.
    await page.goto(`${session.origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [session.key, session.value] as const);
  } finally {
    await ctx.close();
  }
  return dir;
}

/** Median Lighthouse numbers over `runs` navigations (a fresh Chrome each, the same profile seed). */
export async function measurePage(target: LighthouseTarget, runs = 3) {
  const results = [];
  const lhrs = [];
  for (let i = 0; i < runs; i++) {
    // A fresh profile per run: a warm cache would make the second run flatter than a first visit.
    const profile = target.session ? await seedProfile(target.session) : fs.mkdtempSync(path.join(os.tmpdir(), 'lh-profile-'));
    try {
      const lhr = await runOnce(target, profile);
      lhrs.push(lhr);
      results.push(extractMetrics(lhr));
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  return { measured: medianMetrics(results), runs: results, lhrs };
}
