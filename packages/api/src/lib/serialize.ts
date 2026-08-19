// DB rows carry Date objects (Drizzle timestamp mode); the API contract
// (@inventory/shared schemas) speaks ISO strings. Serialization happens here, once.

export const toIso = (date: Date | null): string | null =>
  date ? date.toISOString() : null;

export function serializeAudit<
  T extends { createdAt: Date; updatedAt: Date; deletedAt: Date | null },
>(row: T) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: toIso(row.deletedAt),
  };
}
