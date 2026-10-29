import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import * as tableViewController from '../controllers/table-view.controller';

const router = Router();

router.get('/:tableKey', authenticate, tableViewController.getView);
router.put('/:tableKey', authenticate, validate(tableViewController.tableViewConfigSchema), tableViewController.upsertView);

export default router;
