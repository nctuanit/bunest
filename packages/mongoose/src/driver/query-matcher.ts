import {
  deepClone,
  deleteNestedValue,
  getNestedValue,
  isPlainObject,
  setNestedValue,
} from "../utils/shared.utils";
import { ObjectId } from "./object-id";

function normalizeComparable(value: unknown): unknown {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString(): string }).toHexString().toLowerCase();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return value;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return a === b;
  }
  const na = normalizeComparable(a);
  const nb = normalizeComparable(b);
  if (na === nb) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => valuesEqual(item, b[idx]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => valuesEqual(a[k], b[k]));
  }
  return false;
}

export function compareValues(a: unknown, b: unknown): number {
  const na = normalizeComparable(a);
  const nb = normalizeComparable(b);
  if (na === nb) return 0;
  if (na === undefined || na === null) return -1;
  if (nb === undefined || nb === null) return 1;
  if (typeof na === "number" && typeof nb === "number") {
    return na - nb;
  }
  const sa = String(na);
  const sb = String(nb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isOperatorObject(val: unknown): val is Record<string, any> {
  if (!isPlainObject(val)) return false;
  const keys = Object.keys(val);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function matchesCondition(fieldVal: any, condition: any): boolean {
  if (condition instanceof RegExp) {
    if (Array.isArray(fieldVal)) {
      return fieldVal.some(
        (item) => typeof item === "string" && condition.test(item),
      );
    }
    return typeof fieldVal === "string" && condition.test(fieldVal);
  }

  if (isOperatorObject(condition)) {
    for (const [op, expected] of Object.entries(condition)) {
      switch (op) {
        case "$eq":
          if (Array.isArray(fieldVal)) {
            if (
              !valuesEqual(fieldVal, expected) &&
              !fieldVal.some((item) => valuesEqual(item, expected))
            ) {
              return false;
            }
          } else if (!valuesEqual(fieldVal, expected)) {
            return false;
          }
          break;
        case "$ne":
          if (Array.isArray(fieldVal)) {
            if (
              valuesEqual(fieldVal, expected) ||
              fieldVal.some((item) => valuesEqual(item, expected))
            ) {
              return false;
            }
          } else if (valuesEqual(fieldVal, expected)) {
            return false;
          }
          break;
        case "$gt":
          if (fieldVal === undefined || fieldVal === null) return false;
          if (Array.isArray(fieldVal)) {
            if (!fieldVal.some((v) => compareValues(v, expected) > 0)) return false;
          } else if (!(compareValues(fieldVal, expected) > 0)) {
            return false;
          }
          break;
        case "$gte":
          if (fieldVal === undefined || fieldVal === null) return false;
          if (Array.isArray(fieldVal)) {
            if (!fieldVal.some((v) => compareValues(v, expected) >= 0)) return false;
          } else if (!(compareValues(fieldVal, expected) >= 0)) {
            return false;
          }
          break;
        case "$lt":
          if (fieldVal === undefined || fieldVal === null) return false;
          if (Array.isArray(fieldVal)) {
            if (!fieldVal.some((v) => compareValues(v, expected) < 0)) return false;
          } else if (!(compareValues(fieldVal, expected) < 0)) {
            return false;
          }
          break;
        case "$lte":
          if (fieldVal === undefined || fieldVal === null) return false;
          if (Array.isArray(fieldVal)) {
            if (!fieldVal.some((v) => compareValues(v, expected) <= 0)) return false;
          } else if (!(compareValues(fieldVal, expected) <= 0)) {
            return false;
          }
          break;
        case "$in": {
          const list = Array.isArray(expected) ? expected : [expected];
          if (Array.isArray(fieldVal)) {
            if (
              !fieldVal.some((item) =>
                list.some((e) =>
                  e instanceof RegExp
                    ? typeof item === "string" && e.test(item)
                    : valuesEqual(item, e),
                ),
              )
            ) {
              return false;
            }
          } else {
            if (
              !list.some((e) =>
                e instanceof RegExp
                  ? typeof fieldVal === "string" && e.test(fieldVal)
                  : valuesEqual(fieldVal, e),
              )
            ) {
              return false;
            }
          }
          break;
        }
        case "$nin": {
          const list = Array.isArray(expected) ? expected : [expected];
          if (Array.isArray(fieldVal)) {
            if (
              fieldVal.some((item) => list.some((e) => valuesEqual(item, e)))
            ) {
              return false;
            }
          } else if (list.some((e) => valuesEqual(fieldVal, e))) {
            return false;
          }
          break;
        }
        case "$exists": {
          const exists = fieldVal !== undefined;
          if (Boolean(expected) !== exists) return false;
          break;
        }
        case "$regex": {
          const flags =
            typeof condition.$options === "string" ? condition.$options : "";
          const regex =
            expected instanceof RegExp
              ? new RegExp(expected.source, flags || expected.flags)
              : new RegExp(String(expected), flags);
          if (Array.isArray(fieldVal)) {
            if (!fieldVal.some((item) => typeof item === "string" && regex.test(item))) {
              return false;
            }
          } else if (!(typeof fieldVal === "string" && regex.test(fieldVal))) {
            return false;
          }
          break;
        }
        case "$options":
          break;
        case "$not":
          if (matchesCondition(fieldVal, expected)) return false;
          break;
        case "$size":
          if (!Array.isArray(fieldVal) || fieldVal.length !== expected) {
            return false;
          }
          break;
        case "$all": {
          if (!Array.isArray(fieldVal) || !Array.isArray(expected)) return false;
          if (!expected.every((req) => fieldVal.some((item) => valuesEqual(item, req)))) {
            return false;
          }
          break;
        }
        case "$elemMatch": {
          if (!Array.isArray(fieldVal)) return false;
          if (
            !fieldVal.some((item) =>
              isPlainObject(item)
                ? matchesFilter(item, expected)
                : matchesCondition(item, expected),
            )
          ) {
            return false;
          }
          break;
        }
        case "$type": {
          const actual =
            fieldVal === null
              ? "null"
              : Array.isArray(fieldVal)
                ? "array"
                : fieldVal instanceof Date
                  ? "date"
                  : fieldVal instanceof ObjectId
                    ? "objectId"
                    : typeof fieldVal;
          if (actual !== expected) return false;
          break;
        }
        default:
          break;
      }
    }
    return true;
  }

  if (Array.isArray(fieldVal) && !Array.isArray(condition)) {
    return fieldVal.some((item) => valuesEqual(item, condition));
  }
  return valuesEqual(fieldVal, condition);
}

export function matchesFilter(
  doc: Record<string, any>,
  filter?: Record<string, any>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(value) || !value.every((sub) => matchesFilter(doc, sub))) {
        return false;
      }
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(value) || !value.some((sub) => matchesFilter(doc, sub))) {
        return false;
      }
      continue;
    }
    if (key === "$nor") {
      if (!Array.isArray(value) || value.some((sub) => matchesFilter(doc, sub))) {
        return false;
      }
      continue;
    }
    const fieldVal = getNestedValue(doc, key);
    if (!matchesCondition(fieldVal, value)) {
      return false;
    }
  }
  return true;
}

export function applyUpdateOperators(
  target: Record<string, any>,
  update: Record<string, any>,
  isUpsert = false,
): Record<string, any> {
  const keys = Object.keys(update);
  const hasOperators = keys.some((k) => k.startsWith("$"));

  if (!hasOperators) {
    for (const [k, v] of Object.entries(update)) {
      if (k === "_id") continue;
      setNestedValue(target, k, deepClone(v));
    }
    return target;
  }

  for (const [op, payload] of Object.entries(update)) {
    if (!isPlainObject(payload)) continue;
    switch (op) {
      case "$set":
        for (const [field, val] of Object.entries(payload)) {
          setNestedValue(target, field, deepClone(val));
        }
        break;
      case "$setOnInsert":
        if (isUpsert) {
          for (const [field, val] of Object.entries(payload)) {
            setNestedValue(target, field, deepClone(val));
          }
        }
        break;
      case "$unset":
        for (const field of Object.keys(payload)) {
          deleteNestedValue(target, field);
        }
        break;
      case "$inc":
        for (const [field, amount] of Object.entries(payload)) {
          const cur = Number(getNestedValue(target, field) ?? 0);
          setNestedValue(target, field, cur + Number(amount));
        }
        break;
      case "$mul":
        for (const [field, factor] of Object.entries(payload)) {
          const cur = Number(getNestedValue(target, field) ?? 0);
          setNestedValue(target, field, cur * Number(factor));
        }
        break;
      case "$min":
        for (const [field, val] of Object.entries(payload)) {
          const cur = getNestedValue(target, field);
          if (cur === undefined || compareValues(val, cur) < 0) {
            setNestedValue(target, field, deepClone(val));
          }
        }
        break;
      case "$max":
        for (const [field, val] of Object.entries(payload)) {
          const cur = getNestedValue(target, field);
          if (cur === undefined || compareValues(val, cur) > 0) {
            setNestedValue(target, field, deepClone(val));
          }
        }
        break;
      case "$rename":
        for (const [oldField, newField] of Object.entries(payload)) {
          const cur = getNestedValue(target, oldField);
          if (cur !== undefined) {
            deleteNestedValue(target, oldField);
            setNestedValue(target, String(newField), cur);
          }
        }
        break;
      case "$push":
        for (const [field, val] of Object.entries(payload)) {
          let arr = getNestedValue(target, field);
          if (!Array.isArray(arr)) {
            arr = [];
            setNestedValue(target, field, arr);
          }
          if (isPlainObject(val) && Array.isArray(val.$each)) {
            for (const item of val.$each) {
              arr.push(deepClone(item));
            }
          } else {
            arr.push(deepClone(val));
          }
        }
        break;
      case "$addToSet":
        for (const [field, val] of Object.entries(payload)) {
          let arr = getNestedValue(target, field);
          if (!Array.isArray(arr)) {
            arr = [];
            setNestedValue(target, field, arr);
          }
          const items =
            isPlainObject(val) && Array.isArray(val.$each) ? val.$each : [val];
          for (const item of items) {
            if (!arr.some((existing: unknown) => valuesEqual(existing, item))) {
              arr.push(deepClone(item));
            }
          }
        }
        break;
      case "$pull":
        for (const [field, condition] of Object.entries(payload)) {
          const arr = getNestedValue(target, field);
          if (Array.isArray(arr)) {
            const filtered = arr.filter((item: unknown) =>
              isPlainObject(item) && isPlainObject(condition) && !isOperatorObject(condition)
                ? !matchesFilter(item, condition)
                : !matchesCondition(item, condition),
            );
            setNestedValue(target, field, filtered);
          }
        }
        break;
      case "$pop":
        for (const [field, direction] of Object.entries(payload)) {
          const arr = getNestedValue(target, field);
          if (Array.isArray(arr)) {
            if (Number(direction) < 0) {
              arr.shift();
            } else {
              arr.pop();
            }
          }
        }
        break;
      default:
        break;
    }
  }
  return target;
}

export function applyProjection(
  doc: Record<string, any>,
  projection?: string | Record<string, number | boolean>,
): Record<string, any> {
  if (!projection) {
    return doc;
  }

  const fields: Record<string, 0 | 1> = {};
  if (typeof projection === "string") {
    for (const rawToken of projection.split(/\s+/)) {
      const token = rawToken.trim();
      if (!token) continue;
      if (token.startsWith("-")) {
        fields[token.slice(1)] = 0;
      } else if (token.startsWith("+")) {
        fields[token.slice(1)] = 1;
      } else {
        fields[token] = 1;
      }
    }
  } else {
    for (const [k, v] of Object.entries(projection)) {
      fields[k] = v ? 1 : 0;
    }
  }

  const nonIdEntries = Object.entries(fields).filter(([k]) => k !== "_id");
  const hasIncludes = nonIdEntries.some(([, v]) => v === 1);
  const excludeId = fields._id === 0;

  if (hasIncludes) {
    const out: Record<string, any> = {};
    if (!excludeId && "_id" in doc) {
      out._id = doc._id;
    }
    for (const [k, v] of nonIdEntries) {
      if (v === 1) {
        const val = getNestedValue(doc, k);
        if (val !== undefined) {
          setNestedValue(out, k, val);
        }
      }
    }
    return out;
  }

  const out = deepClone(doc);
  if (excludeId) {
    delete out._id;
  }
  for (const [k, v] of nonIdEntries) {
    if (v === 0) {
      deleteNestedValue(out, k);
    }
  }
  return out;
}

export function parseSortSpec(
  sort: string | Record<string, 1 | -1 | "asc" | "desc" | "ascending" | "descending">,
): Array<[string, 1 | -1]> {
  const result: Array<[string, 1 | -1]> = [];
  if (typeof sort === "string") {
    for (const raw of sort.split(/\s+/)) {
      const token = raw.trim();
      if (!token) continue;
      if (token.startsWith("-")) {
        result.push([token.slice(1), -1]);
      } else if (token.startsWith("+")) {
        result.push([token.slice(1), 1]);
      } else {
        result.push([token, 1]);
      }
    }
  } else {
    for (const [k, v] of Object.entries(sort)) {
      const dir: 1 | -1 =
        v === -1 || v === "desc" || v === "descending" ? -1 : 1;
      result.push([k, dir]);
    }
  }
  return result;
}
