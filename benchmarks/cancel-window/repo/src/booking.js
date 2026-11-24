export function createBooking(id, startsAt) {
  return { id, startsAt: new Date(startsAt), status: 'active' };
}

export function cancelBooking(booking, now = new Date()) {
  booking.status = 'cancelled';
  booking.cancelledAt = new Date(now);
  return booking;
}
