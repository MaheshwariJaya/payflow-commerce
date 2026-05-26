/**
 * Safely serializes objects containing BigInt fields (like amount_paise) into standard JSON-compatible formats by converting BigInts to strings.
 */
export function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  return JSON.parse(
    JSON.stringify(obj, (key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      return value;
    })
  );
}
