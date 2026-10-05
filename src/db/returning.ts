/**
 * Rows from a `... RETURNING` query run through TypeORM's DataSource/EntityManager.query():
 * INSERT returns the rows themselves, but UPDATE/DELETE return `[rows, affectedCount]`.
 */
export function returningRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return (result ?? []) as T[];
}
