#!/usr/bin/env node
// Verifies every entry in root package.json's `overrides` block is actually
// reflected in package-lock.json's resolved tree. `overrides` is a resolution
// hint npm only applies while building a NEW tree from scratch - a routine
// `npm install`/`npm ci` will not retroactively re-resolve an already-
// satisfying subtree just because `overrides` changed, so a declared floor
// and the real resolved version can silently drift apart. This walks the
// same nested-override + node_modules-hoisting resolution npm itself uses,
// so it catches that drift instead of just trusting the lockfile.
const fs = require('fs');
const path = require('path');
const semver = require('semver');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const overrides = pkg.overrides || {};
const packages = lock.packages || {};

// From a lockfile package key, list ancestor contexts nearest-first, ending
// in '' (root) - mirrors Node's node_modules resolution walk-up.
function ancestorContexts(key) {
  const contexts = [key];
  let cur = key;
  while (cur.includes('node_modules/')) {
    const idx = cur.lastIndexOf('node_modules/');
    cur = cur.slice(0, idx).replace(/\/$/, '');
    contexts.push(cur);
  }
  return contexts;
}

// Resolve `depName` as required by the package at lockfile key `contextKey`,
// using nearest-ancestor node_modules lookup (handles hoisting/dedup).
function resolveDependency(contextKey, depName) {
  for (const ctx of ancestorContexts(contextKey)) {
    const candidate = ctx === '' ? `node_modules/${depName}` : `${ctx}/node_modules/${depName}`;
    if (packages[candidate]) return candidate;
  }
  return null;
}

const failures = [];
const checked = [];

// Blanket override: `{ "pkg": "range" }` - applies to every occurrence.
function checkBlanket(name, range) {
  const matches = Object.keys(packages).filter(
    (k) => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`)
  );
  if (matches.length === 0) {
    checked.push(`${name}@${range}: not present in tree (nothing to enforce)`);
    return;
  }
  for (const key of matches) {
    const version = packages[key].version;
    if (!version) continue;
    const ok = semver.satisfies(version, range);
    checked.push(`${name}@${range}: ${key} -> ${version} ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures.push(`${key} resolves to ${version}, violating override ${name}@${range}`);
  }
}

// Scoped/nested override: walk the key chain from root, resolving each hop
// through the actual dependency graph, same as npm does.
function checkScoped(keyChain, range) {
  let context = '';
  for (let i = 0; i < keyChain.length - 1; i++) {
    const next = resolveDependency(context, keyChain[i]);
    if (!next) {
      checked.push(`${keyChain.join(' > ')}@${range}: ${keyChain[i]} not found under ${context || '<root>'} (nothing to enforce)`);
      return;
    }
    context = next;
  }
  const leafName = keyChain[keyChain.length - 1];
  const target = leafName === '.' ? context : resolveDependency(context, leafName);
  if (!target) {
    checked.push(`${keyChain.join(' > ')}@${range}: not found under ${context} (nothing to enforce)`);
    return;
  }
  const version = packages[target] && packages[target].version;
  if (!version) return;
  const ok = semver.satisfies(version, range);
  checked.push(`${keyChain.join(' > ')}@${range}: ${target} -> ${version} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures.push(`${target} resolves to ${version}, violating scoped override ${keyChain.join(' > ')}@${range}`);
}

function walk(node, keyChain) {
  if (typeof node === 'string') {
    if (keyChain.length === 1) checkBlanket(keyChain[0], node);
    else checkScoped(keyChain, node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, [...keyChain, k]);
  }
}

for (const [name, spec] of Object.entries(overrides)) walk(spec, [name]);

console.log(`Checked ${checked.length} override target(s):`);
for (const line of checked) console.log(`  ${line}`);

if (failures.length > 0) {
  console.error('\nOverrides declared in package.json are NOT reflected in package-lock.json:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nnpm does not re-resolve an already-satisfying subtree just because `overrides` ' +
      'changed - regenerate the affected lockfile entries (or the whole lockfile) so the ' +
      'declared floor is actually enforced.'
  );
  process.exit(1);
}

console.log('\nAll declared overrides are enforced in the resolved tree.');
