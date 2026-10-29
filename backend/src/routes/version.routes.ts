import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { env } from '../config/env';

const router = Router();

// Which commit is this deploy actually running?
//
// Until this existed there was no way to answer that from outside the box. The
// platform health check reports liveness, not identity, and a promotion that
// ships no migration leaves nothing in the database to observe — so "we merged
// it to main" was the strongest claim anyone could honestly make about a
// release. This closes that gap for every future promotion, not just the one
// that exposed it.
//
// AUTHENTICATED, deliberately. The commit SHA of a private repo is low-grade
// information but it is still build intelligence, and /health is public because
// the platform probe hits the origin directly — that exemption is not a reason
// to hang more on it. Any signed-in user may read this; it is not org-scoped
// data, so there is no attachAbility/canDo pairing here.
router.use(authenticate);

router.get('/', (_req, res) => {
  res.json({
    // Full 40-char SHA, never shortened: the caller settles "is commit X live?"
    // with `git merge-base --is-ancestor X <this>`, an ancestry test, not string
    // equality — main moves on after a promotion, so the running commit is
    // routinely a DESCENDANT of the one being asked about.
    commit: env.RENDER_GIT_COMMIT ?? null,
    // Which branch this service deploys from. Present because the services are
    // easy to mix up when checking a release, and reading the wrong one answers
    // a different question convincingly.
    branch: env.RENDER_GIT_BRANCH ?? null,
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

export default router;
