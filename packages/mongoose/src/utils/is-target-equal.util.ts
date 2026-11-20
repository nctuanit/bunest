export type TargetHost = Record<"target", Function>;

export function isTargetEqual<T extends TargetHost, U extends TargetHost>(
  a: T,
  b: U,
): boolean {
  if (a.target === b.target) {
    return true;
  }
  if (a.target && a.target.prototype) {
    const parentTarget = Object.getPrototypeOf(a.target);
    if (parentTarget && parentTarget !== Function.prototype) {
      return isTargetEqual({ target: parentTarget }, b);
    }
  }
  return false;
}
