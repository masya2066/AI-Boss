/** cart = { items: [{ productId, price, qty }] } */
export function total(cart) {
  return Math.round(cart.items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
}
