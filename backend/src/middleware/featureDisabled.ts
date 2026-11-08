import { Request, Response } from 'express';

// Parked-feature guard (plan D4/D6, A-18): the route stays mounted so un-parking
// is a one-line revert, but every verb answers 404 so hidden UI can't leave a
// live orphan write path. Terminal — never calls next().
// 'line_stock_sync' is declared ahead of use: LO-4 parks the legacy job/invoice line
// stock-sync routes once Logistic Orders own that path. NOT mounted on any route yet.
export function featureDisabled(feature: 'rfq' | 'stock_approvals' | 'line_stock_sync') {
  return (_req: Request, res: Response) => {
    res.status(404).json({ error: 'FEATURE_DISABLED', feature });
  };
}
