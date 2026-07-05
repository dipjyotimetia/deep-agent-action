// Deliberately buggy: uses assignment instead of comparison.
export function isEven(n: number): boolean {
  let result;
  if ((result = n % 2) == 0) {
    return true;
  }
  return false;
}
