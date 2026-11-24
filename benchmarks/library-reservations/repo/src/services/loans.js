import { findById, insert, where } from '../db/memory.js';
import { availableCopies } from './catalog.js';
import { getMember } from './members.js';

export const MAX_ACTIVE_LOANS = 3;
export const LOAN_DAYS = 14;

export function borrow(db, { memberId, bookId, now = new Date() }) {
  getMember(db, memberId);
  if (availableCopies(db, bookId) < 1) throw new Error('no copies available');
  const active = where(db, 'loans', (l) => l.memberId === memberId && !l.returnedAt);
  if (active.length >= MAX_ACTIVE_LOANS) throw new Error(`limit of ${MAX_ACTIVE_LOANS} active loans reached`);
  const due = new Date(now.getTime() + LOAN_DAYS * 86400_000);
  return insert(db, 'loans', { memberId, bookId, borrowedAt: now.toISOString(), dueAt: due.toISOString(), returnedAt: null });
}

export function returnBook(db, { loanId, now = new Date() }) {
  const loan = findById(db, 'loans', loanId);
  if (!loan) throw new Error(`unknown loan ${loanId}`);
  if (loan.returnedAt) throw new Error('loan already returned');
  loan.returnedAt = now.toISOString();
  return loan;
}

export const activeLoans = (db, memberId) => where(db, 'loans', (l) => l.memberId === memberId && !l.returnedAt);
