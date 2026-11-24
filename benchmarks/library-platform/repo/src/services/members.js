import { findById, insert } from '../db/memory.js';

export function addMember(db, { name, email }) {
  if (!name || !email || !email.includes('@')) throw new Error('name and a valid email are required');
  return insert(db, 'members', { name, email });
}

export function getMember(db, id) {
  const m = findById(db, 'members', id);
  if (!m) throw new Error(`unknown member ${id}`);
  return m;
}
