import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { openLive } from '../controllers/live.controller';

/** The signed-in person's own live line (#3472): it carries only the messages addressed to them. */
const router = Router();

router.get('/', authenticate, openLive);

export default router;
