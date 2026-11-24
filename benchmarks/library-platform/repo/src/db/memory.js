// Minimal in-memory tables. Every table is an array of plain objects with an `id`.
let seq = 0;
export const nextId = (prefix) => `${prefix}_${++seq}`;

export function createDb() {
  return { books: [], members: [], loans: [] };
}

export function insert(db, table, row) {
  const rec = { id: nextId(table.slice(0, -1)), ...row };
  db[table].push(rec);
  return rec;
}

export const findById = (db, table, id) => db[table].find((r) => r.id === id);
export const where = (db, table, pred) => db[table].filter(pred);
