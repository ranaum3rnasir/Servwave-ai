import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireUuidParam } from '../middleware/requireUuidParam';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, attachAbility, attachCustomerScope);

// Tag CRUD
router.get('/', canDo('read', 'Tag'), tagController.list);
router.post('/', canDo('create', 'Tag'), validate(tagController.createTagSchema), tagController.create);
// Org-wide edits to the shared tag row. ADMIN-only: `update`/`delete Tag` have no
// defaultGrants row, so only `manage all` reaches them.
//
// requireUuidParam sits AFTER canDo so a non-admin still gets 403, not a 404 that
// would tell them whether the id was well-formed. `tags.id` is a Postgres uuid, so
// without the guard a stray path segment reaches prisma.tag.findFirst, the driver
// throws P2023 and the controller's catch dresses a client typo up as a 500.
const tagId = requireUuidParam('id', 'Tag not found');

router.patch('/:id', canDo('update', 'Tag'), tagId, validate(tagController.updateTagSchema), tagController.update);
router.delete('/:id', canDo('delete', 'Tag'), tagId, tagController.remove);

export default router;
