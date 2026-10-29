import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import * as searchController from '../controllers/search.controller';

const router = Router();

router.use(authenticate, attachAbility);

router.get('/', searchController.search);

export default router;
