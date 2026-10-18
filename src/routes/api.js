import { Router } from 'express';
import * as auth from '../services/auth.js';
import * as inv from '../services/inventory.js';
import * as po from '../services/purchasing.js';
import * as sales from '../services/sales.js';
import * as fc from '../services/forecasting.js';
import { AppError, badRequest, forbidden, unauthorized } from '../errors.js';
import { today } from '../dates.js';
import { id, oneOf } from '../validate.js';
import { createLoginLimiter } from '../security.js';

const COOKIE = 'ps_session';
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.json(data)).catch(next);

/** Staff must never see purchase prices — strip them centrally, not per page. */
const COST_KEYS = new Set(['unit_cost', 'unitCost']);
export function stripCosts(value) {
  if (Array.isArray(value)) return value.map(stripCosts);
  // Only walk plain objects: Dates (timestamps) etc. must pass through untouched.
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !COST_KEYS.has(k)).map(([k, v]) => [k, stripCosts(v)]));
  }
  return value;
}

export function apiRouter(pool, { loginLimiter = createLoginLimiter() } = {}) {
  const r = Router();

  // Every :id-style path parameter must be a positive integer — checked once, here.
  for (const name of ['id', 'productId']) {
    r.param(name, (req, _res, next, value) => {
      try { req.params[name] = id(value, name === 'id' ? 'ID' : 'Product ID'); next(); } catch (e) { next(e); }
    });
  }
  const optionalId = (v, label) => (v === undefined || v === '' ? null : id(v, label));

  const authn = async (req, res, next) => {
    try {
      req.user = await auth.userForToken(pool, req.cookies?.[COOKIE]);
      if (!req.user) throw unauthorized();
      next();
    } catch (e) { next(e); }
  };
  const ownerOnly = (req, _res, next) => (req.user.role === 'owner' ? next() : next(forbidden('Owner only')));
  const forRole = (req, data) => (req.user.role === 'owner' ? data : stripCosts(data));

  // ---- auth ----
  r.post('/auth/login', wrap(async (req, res) => {
    const blocked = loginLimiter.check(req, res);
    if (blocked) throw new AppError(429, blocked);
    try {
      const { token, user } = await auth.login(pool, req.body?.username, req.body?.password);
      loginLimiter.succeed(req);
      // httpOnly: JS can't read it (XSS can't steal it); sameSite strict: not sent cross-site (CSRF).
      res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 7 * 864e5, path: '/' });
      return { user };
    } catch (e) {
      if (e.status === 401) loginLimiter.fail(req);
      throw e;
    }
  }));
  r.post('/auth/logout', wrap(async (req, res) => {
    await auth.logout(pool, req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE);
    return { ok: true };
  }));

  r.use(authn);
  r.get('/me', wrap(async (req) => ({ user: req.user, today: today() })));

  // ---- catalogue ----
  r.get('/products', wrap(async (req) => forRole(req, await inv.listProducts(pool))));
  r.post('/products', ownerOnly, wrap(async (req, res) => { res.status(201); return inv.createProduct(pool, req.body); }));
  r.get('/suppliers', wrap(async () => inv.listSuppliers(pool)));
  r.post('/suppliers', ownerOnly, wrap(async (req, res) => { res.status(201); return inv.createSupplier(pool, req.body); }));
  r.patch('/products/:id', ownerOnly, wrap(async (req) => inv.updateProduct(pool, req.params.id, req.body)));
  r.patch('/suppliers/:id', ownerOnly, wrap(async (req) => inv.updateSupplier(pool, req.params.id, req.body)));

  // ---- batches / expiry / history ----
  r.get('/batches', wrap(async (req) => forRole(req, await inv.listBatches(pool, { productId: optionalId(req.query.productId, 'Product ID') }))));
  r.get('/alerts/expiry', wrap(async (req) => forRole(req, await inv.expiryAlerts(pool))));
  r.post('/batches/:id/write-off', ownerOnly, wrap(async (req) => inv.writeOffBatch(pool, req.user.id, req.params.id, req.body.reason)));
  r.get('/stock-history', ownerOnly, wrap(async (req) => inv.stockHistory(pool, { productId: optionalId(req.query.productId, 'Product ID') })));

  // ---- sales ----
  r.post('/sales', wrap(async (req, res) => { res.status(201); return sales.createSale(pool, req.user.id, req.body); }));
  r.get('/sales', wrap(async () => sales.recentSales(pool)));
  r.get('/summary', wrap(async () => sales.salesSummary(pool)));

  // ---- purchasing ----
  r.get('/purchase-orders', wrap(async (req) => forRole(req, await po.listPurchaseOrders(pool, { status: req.query.status ? oneOf(req.query.status, 'Status', ['draft', 'ordered', 'received', 'cancelled']) : null }))));
  r.get('/purchase-orders/:id', wrap(async (req) => forRole(req, await po.getPurchaseOrder(pool, req.params.id))));
  r.post('/purchase-orders', ownerOnly, wrap(async (req, res) => { res.status(201); return po.createPurchaseOrder(pool, req.user.id, req.body); }));
  r.put('/purchase-orders/:id/items', ownerOnly, wrap(async (req) => po.updateDraftItems(pool, req.params.id, req.body.items)));
  r.post('/purchase-orders/:id/place', ownerOnly, wrap(async (req) => po.placeOrder(pool, req.params.id)));
  r.post('/purchase-orders/:id/cancel', ownerOnly, wrap(async (req) => po.cancelOrder(pool, req.params.id)));
  r.post('/purchase-orders/:id/receive', wrap(async (req) =>
    forRole(req, await po.receiveOrder(pool, req.user.id, req.params.id, req.body, { canSetCost: req.user.role === 'owner' }))));

  // ---- forecasting (owner) ----
  r.get('/reorder-plan', ownerOnly, wrap(async () => fc.reorderPlan(pool)));
  r.post('/reorder-plan/draft-pos', ownerOnly, wrap(async (req, res) => { res.status(201); return fc.draftPosFromPlan(pool, req.user.id, req.body.items); }));
  r.get('/forecast/:productId', ownerOnly, wrap(async (req) => fc.productForecast(pool, req.params.productId)));
  r.post('/forecast/:productId/draft-po', ownerOnly, wrap(async (req, res) => { res.status(201); return fc.draftPoFromRecommendation(pool, req.user.id, req.params.productId); }));
  r.get('/model-report', ownerOnly, wrap(async () => fc.modelReport(pool)));

  // ---- staff management (owner) ----
  r.get('/users', ownerOnly, wrap(async () => auth.listUsers(pool)));
  r.post('/users', ownerOnly, wrap(async (req, res) => { res.status(201); return auth.createUser(pool, req.body); }));
  r.patch('/users/:id', ownerOnly, wrap(async (req) => {
    if (typeof req.body?.active !== 'boolean') throw badRequest('active must be true or false');
    return auth.setUserActive(pool, req.params.id, req.body.active, req.user.id);
  }));

  return r;
}
