import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as invLocationsController from '../controllers/inv-locations.controller';

const router = Router();

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Branches ───────────────────────────────────────────
router.get('/branches', canDo('read', 'Inventory'), invLocationsController.listBranches);
router.post('/branches', canDo('create', 'Inventory'), validate(invLocationsController.createBranchSchema), invLocationsController.createBranch);
router.get('/branches/:id', canDo('read', 'Inventory'), invLocationsController.getBranch);
router.patch('/branches/:id', canDo('update', 'Inventory'), validate(invLocationsController.updateBranchSchema), invLocationsController.updateBranch);
router.delete('/branches/:id', canDo('delete', 'Inventory'), invLocationsController.deleteBranch);

// ─── My-van (P3 — tech truck-stock view) ────────────────
// Own-scope by construction (primary_tech_id = requester + tenantWhere, /my-today pattern).
// Gate = `read PriceBook`: the body is catalog items + the requester's OWN balances; every role
// passes after the P3 grant, and `read Inventory` would exclude the very audience (techs) while
// a hardcoded role check would break dispatchers/admins with vans. Widens Inventory: no — the
// subject is never consulted. Response is cost-stripped by projection in the controller.
router.get('/my-van', canDo('read', 'PriceBook'), invLocationsController.myVan);

// ─── Locations ──────────────────────────────────────────
router.get('/locations', canDo('read', 'Inventory'), invLocationsController.listLocations);
router.post('/locations', canDo('create', 'Inventory'), validate(invLocationsController.createLocationSchema), invLocationsController.createLocation);
router.get('/locations/:id', canDo('read', 'Inventory'), invLocationsController.getLocation);
router.patch('/locations/:id', canDo('update', 'Inventory'), validate(invLocationsController.updateLocationSchema), invLocationsController.updateLocation);
router.delete('/locations/:id', canDo('delete', 'Inventory'), invLocationsController.deleteLocation);

export default router;
