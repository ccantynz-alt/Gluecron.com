/**
 * workflow-matrix.ts
 *
 * Pure-function matrix expansion for workflow jobs. No DB, no I/O, no deps.
 *
 * Semantics mirror GitHub Actions `strategy.matrix`:
 *   - Cartesian product of named axes.
 *   - `exclude`: remove any cartesian combo whose keys all match an exclude entry.
 *   - `include`: extend an existing combo if it matches on all of include's keys,
 *                otherwise append as a standalone combo.
 *
 * Never throws. On bad input returns [].
 */

export type MatrixSpec = {
  axes: Record<string, unknown[]>;
  include?: Record<string, unknown>[];
  exclude?: Record<string, unknown>[];
  failFast?: boolean;
  maxParallel?: number;
};

export type MatrixCombo = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Deep-equality for primitive-holding matrix values.
// Supports scalars, arrays, and plain objects nested arbitrarily.
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual(ao[ak[i]!], bo[bk[i]!])) return false;
  }
  return true;
}

// A combo matches a partial entry iff every key in the entry deep-equals
// the same key in the combo. Keys not in the entry are ignored.
function matchesPartial(combo: MatrixCombo, partial: Record<string, unknown>): boolean {
  for (const k of Object.keys(partial)) {
    if (!(k in combo)) return false;
    if (!deepEqual(combo[k], partial[k])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cartesian expansion.
// Sort axis keys alphabetically so ordering is deterministic across runs.
// ---------------------------------------------------------------------------

function cartesian(axes: Record<string, unknown[]>): MatrixCombo[] {
  const keys = Object.keys(axes).sort();
  if (keys.length === 0) return [];
  // If any axis has zero values, the product is empty — matches GitHub Actions.
  for (const k of keys) {
    const v = axes[k];
    if (!Array.isArray(v) || v.length === 0) return [];
  }
  let combos: MatrixCombo[] = [{}];
  for (const k of keys) {
    const values = axes[k]!;
    const next: MatrixCombo[] = [];
    for (const combo of combos) {
      for (const val of values) {
        next.push({ ...combo, [k]: val });
      }
    }
    combos = next;
  }
  return combos;
}

export function expandMatrix(spec: MatrixSpec): MatrixCombo[] {
  if (!spec || typeof spec !== "object") return [];
  const axes = spec.axes;
  const include = Array.isArray(spec.include) ? spec.include : [];
  const exclude = Array.isArray(spec.exclude) ? spec.exclude : [];

  // Validate axes: must be a plain object mapping string -> array.
  let validAxes: Record<string, unknown[]> = {};
  if (axes && typeof axes === "object" && !Array.isArray(axes)) {
    for (const k of Object.keys(axes)) {
      const v = (axes as Record<string, unknown>)[k];
      if (!Array.isArray(v)) return [];
      validAxes[k] = v;
    }
  } else if (axes !== undefined && axes !== null) {
    return [];
  }

  // 1. Cartesian product (possibly empty if no axes).
  let combos: MatrixCombo[] = cartesian(validAxes);

  // 2. Apply exclude. An exclude entry removes any cartesian combo that
  //    partially matches all of the exclude's keys.
  if (exclude.length > 0) {
    combos = combos.filter((combo) => {
      for (const ex of exclude) {
        if (ex && typeof ex === "object" && matchesPartial(combo, ex)) return false;
      }
      return true;
    });
  }

  // 3. Apply include. For each include entry:
  //    - If it fully matches an existing combo (partial match on include's
  //      keys), merge extra keys into that combo.
  //    - Otherwise append as a standalone combo.
  //    "Matches an existing combo" means the include entry's keys that are
  //    also axis keys deep-equal the combo's values for those keys.
  const axisKeySet = new Set(Object.keys(validAxes));
  for (const inc of include) {
    if (!inc || typeof inc !== "object") continue;
    // Build the matcher: only axis-key fields count for matching.
    const matcher: Record<string, unknown> = {};
    let hasAxisKeys = false;
    for (const k of Object.keys(inc)) {
      if (axisKeySet.has(k)) {
        matcher[k] = inc[k];
        hasAxisKeys = true;
      }
    }
    let extended = false;
    if (hasAxisKeys && combos.length > 0) {
      for (const combo of combos) {
        if (matchesPartial(combo, matcher)) {
          // Extend with extra (non-axis or additive) keys that are not already
          // present in the combo. GitHub Actions semantics: include's extra
          // fields are added, but they never overwrite an axis value.
          for (const k of Object.keys(inc)) {
            if (!(k in combo)) combo[k] = inc[k];
          }
          extended = true;
        }
      }
    }
    if (!extended) {
      // Append as a standalone combo (copy to avoid aliasing caller's object).
      combos.push({ ...inc });
    }
  }

  return combos;
}

// ---------------------------------------------------------------------------
// validateMatrix — type-guard / sanitiser for untrusted input.
// ---------------------------------------------------------------------------

export function validateMatrix(
  spec: unknown,
): { ok: true; spec: MatrixSpec } | { ok: false; error: string } {
  if (spec === null || spec === undefined) {
    return { ok: false, error: "matrix: spec is null or undefined" };
  }
  if (typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, error: "matrix: spec must be an object" };
  }
  const s = spec as Record<string, unknown>;

  const axes: Record<string, unknown[]> = {};
  const rawAxes = s.axes;
  if (rawAxes !== undefined && rawAxes !== null) {
    if (typeof rawAxes !== "object" || Array.isArray(rawAxes)) {
      return { ok: false, error: "matrix: axes must be an object" };
    }
    for (const k of Object.keys(rawAxes as object)) {
      const v = (rawAxes as Record<string, unknown>)[k];
      if (!Array.isArray(v)) {
        return { ok: false, error: `matrix: axis "${k}" must be an array` };
      }
      axes[k] = v;
    }
  }

  let include: Record<string, unknown>[] | undefined;
  if (s.include !== undefined && s.include !== null) {
    if (!Array.isArray(s.include)) {
      return { ok: false, error: "matrix: include must be an array" };
    }
    include = [];
    for (let i = 0; i < s.include.length; i++) {
      const e = s.include[i];
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        return { ok: false, error: `matrix: include[${i}] must be an object` };
      }
      include.push(e as Record<string, unknown>);
    }
  }

  let exclude: Record<string, unknown>[] | undefined;
  if (s.exclude !== undefined && s.exclude !== null) {
    if (!Array.isArray(s.exclude)) {
      return { ok: false, error: "matrix: exclude must be an array" };
    }
    exclude = [];
    for (let i = 0; i < s.exclude.length; i++) {
      const e = s.exclude[i];
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        return { ok: false, error: `matrix: exclude[${i}] must be an object` };
      }
      exclude.push(e as Record<string, unknown>);
    }
  }

  let failFast: boolean | undefined;
  if (s.failFast !== undefined) {
    if (typeof s.failFast !== "boolean") {
      return { ok: false, error: "matrix: failFast must be boolean" };
    }
    failFast = s.failFast;
  }

  let maxParallel: number | undefined;
  if (s.maxParallel !== undefined) {
    if (typeof s.maxParallel !== "number" || !Number.isFinite(s.maxParallel) || s.maxParallel < 1) {
      return { ok: false, error: "matrix: maxParallel must be a positive number" };
    }
    maxParallel = Math.floor(s.maxParallel);
  }

  return {
    ok: true,
    spec: { axes, include, exclude, failFast, maxParallel },
  };
}
