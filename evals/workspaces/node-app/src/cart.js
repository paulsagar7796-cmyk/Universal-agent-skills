// Cart pricing helpers.

/** Sum of price × quantity for every line item. */
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** Apply a percentage coupon. Returns the discounted total. (Coupons carry an `expiresAt` date, not checked yet.) */
export function applyCoupon(total, coupon) {
  if (!coupon) return total;
  return Math.round(total * (100 - coupon.percentOff)) / 100;
}
