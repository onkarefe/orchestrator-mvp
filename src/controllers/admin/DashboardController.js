import { listOrders } from '../../models/OrderModel.js';
import { checkoutSecurity } from '../../utils/adminDisplay.js';

export function summarizeRecentOrders(orders) {
  const attention = orders.filter(order =>
    ['SECURITY_HOLD', 'failed', 'manual_review'].includes(order.status) ||
    order.manual_review_reason || order.last_error || checkoutSecurity(order).result === 'FAIL');
  return {
    total: orders.length,
    active: orders.filter(order => ['received', 'validated', 'processing', 'artifact_ready',
      'factory_received', 'production_started', 'production_completed', 'ready_for_shipping'].includes(order.status)).length,
    holds: orders.filter(order => order.status === 'SECURITY_HOLD').length,
    attention,
  };
}
const DashboardController = {
  async index(req, res, next) {
    try {
      const title = 'Wandini Orchestrator';
      const orders = await listOrders({ limit: 50, offset: 0 });
      res.render('pages/dashboard', { title, orders, summary: summarizeRecentOrders(orders) }, (pageError, body) => {
        if (pageError) return next(pageError);
        res.render('layouts/main', { title, body });
      });
    } catch (error) {
      next(error);
    }
  },
};
export default DashboardController;
