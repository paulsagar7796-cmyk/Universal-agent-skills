// Minimal request router (no framework) used by the app.
import { cartTotal } from './cart.js';

export function requireUser(req) {
  if (!req.user) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  return req.user;
}

export const routes = {
  'GET /cart/total': (req) => {
    requireUser(req);
    return { total: cartTotal(req.body.items ?? []) };
  },
};
