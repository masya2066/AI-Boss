import { findById, insert, where } from '../db/memory.js';

export function addBook(db, { title, author, copies = 1 }) {
  if (!title) throw new Error('title is required');
  if (!Number.isInteger(copies) || copies < 1) throw new Error('copies must be a positive integer');
  return insert(db, 'books', { title, author, copies });
}

export function availableCopies(db, bookId) {
  const book = findById(db, 'books', bookId);
  if (!book) throw new Error(`unknown book ${bookId}`);
  const out = where(db, 'loans', (l) => l.bookId === bookId && !l.returnedAt).length;
  return book.copies - out;
}

export const listBooks = (db) => db.books.map((b) => ({ ...b, available: availableCopies(db, b.id) }));
