// Order export. Currently CSV only.

export function exportOrders(orders) {
  const header = 'id,customer,total';
  const rows = orders.map((o) => `${o.id},${o.customer},${o.total}`);
  return [header, ...rows].join('\n');
}
