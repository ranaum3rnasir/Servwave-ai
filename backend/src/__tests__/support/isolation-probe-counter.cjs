// A plain CommonJS module, loaded through Node's own require cache, which vitest does not reset between test files that
// run in one worker. Each of isolation-probe-a/b.test.ts counts itself in and expects to be the only one: with isolation
// off and both files in one worker, the second sees 2.
module.exports = { users: 0 };
