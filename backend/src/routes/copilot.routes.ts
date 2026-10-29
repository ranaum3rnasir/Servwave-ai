import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as copilot from '../controllers/copilot.controller';

const router = Router();

// Every copilot route is authenticated. Servy acts AS the user — the actual
// per-resource authorization happens at the underlying /api/* endpoints the
// browser tool handlers call (CASL + tenantWhere there). These routes only
// proxy Gemini text generation and manage the user's own conversation history.
router.use(authenticate);

router.post('/generate', expensiveLimiter, validate(copilot.generateRequestSchema), copilot.generate);
router.post('/transcribe', expensiveLimiter, validate(copilot.transcribeRequestSchema), copilot.transcribe);
// Mints the ephemeral token for the browser's real-time Gemini Live voice session.
router.post('/token', expensiveLimiter, validate(copilot.liveTokenSchema), copilot.liveToken);

router.get('/conversations', copilot.listConversations);
router.post('/conversations', validate(copilot.createConversationSchema), copilot.createConversation);
router.get('/conversations/:id', copilot.getConversation);
router.delete('/conversations/:id', copilot.deleteConversation);

router.post('/turns', validate(copilot.appendTurnSchema), copilot.appendTurn);
router.post('/feedback', validate(copilot.feedbackSchema), copilot.feedback);

export default router;
