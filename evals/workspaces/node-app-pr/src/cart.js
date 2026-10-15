// Cart pricing helpers.

/** Sum of price × quantity for every line item. */
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** Apply a percentage coupon if it has not expired. Returns the discounted total. */
export function applyCoupon(total, coupon, now = new Date()) {
  if (!coupon) return total;
  if (new Date(coupon.expiresAt) < now) return total;
  return Math.round(total * (100 - coupon.percentOff)) / 100;
}
