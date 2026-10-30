import { catalogToggle } from './backendSwitchCatalog';

/**
 * The "Me" request and its answer for a person who holds View customers. The customer directory and a customer's own
 * record are asked for only by a person who does, so a suite that feeds the Communication pages customers answers the
 * request this way (the key comes from the catalog, not typed here).
 */
export const MY_SWITCHES_URL = '/api/permission-switches/me';
export const VIEWS_CUSTOMERS_ANSWER = {
  data: { admin_box: false, values: { [catalogToggle('View customers').key]: true } },
};
