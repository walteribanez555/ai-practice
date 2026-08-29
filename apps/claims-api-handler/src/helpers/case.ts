const snakeToCamelKey = (key: string): string =>
  key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());

export function toCamel<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map(toCamel) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        snakeToCamelKey(k),
        toCamel(v),
      ]),
    ) as T;
  }
  return value as T;
}
