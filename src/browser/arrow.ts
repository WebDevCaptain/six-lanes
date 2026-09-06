/**
 * Turning an Arrow result into the plain rows the normaliser expects.
 *
 * This exists because of a bug the correctness gate caught rather than one anybody
 * predicted. DuckDB-WASM returns results as Arrow, and `Row.toJSON()` hands back a
 * DECIMAL as its **unscaled** integer: a revenue of 3,237,919.01 arrives as
 * 323791901. Nothing throws. The lane simply reported a number a hundred times too
 * large, and it was caught only because its rows were compared with another engine's.
 *
 * The scale is in the Arrow schema, so the fix is to read it from there rather than
 * to guess from the value. Timestamps are here for a related reason: they arrive as
 * bare epoch integers, which the normaliser cannot safely interpret on its own.
 */

interface ArrowField {
  readonly name: string;
  readonly type: Record<string, unknown>;
}

interface ArrowTable {
  readonly schema: { readonly fields: readonly ArrowField[] };
  toArray(): { toJSON(): Record<string, unknown> }[];
}

export function arrowRows(table: ArrowTable): Record<string, unknown>[] {
  const decimals = new Map<string, number>();
  const timestamps = new Set<string>();

  for (const field of table.schema.fields) {
    // Structural checks rather than Arrow's Type enum, so this does not break when
    // duckdb-wasm moves to a different apache-arrow major. Decimal is the only Arrow
    // type carrying both scale and precision; Timestamp is the only one carrying both
    // unit and timezone.
    if (typeof field.type['scale'] === 'number' && typeof field.type['precision'] === 'number') {
      decimals.set(field.name, field.type['scale']);
    } else if (typeof field.type['unit'] === 'number' && 'timezone' in field.type) {
      timestamps.add(field.name);
    }
  }

  return table.toArray().map((row) => {
    const object = row.toJSON();
    for (const [name, scale] of decimals) object[name] = applyScale(object[name], scale);
    for (const name of timestamps) object[name] = toIso(object[name]);
    return object;
  });
}

/** Places the decimal point, textually, so no value ever passes through a float. */
function applyScale(value: unknown, scale: number): unknown {
  if (value === null || value === undefined || scale <= 0) return value;
  // Already a decimal string from some other path; leave it be.
  if (typeof value === 'string' && value.includes('.')) return value;

  const unscaled = toBigInt(value);
  if (unscaled === undefined) return value;

  const negative = unscaled < 0n;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/**
 * Arrow timestamps arrive already normalised to epoch milliseconds.
 *
 * Not what the schema implies. DuckDB declares TIMESTAMPTZ as Arrow unit
 * MICROSECOND, and rescaling by that unit produced 1970-01-21 for an order placed in
 * July 2025 - because apache-arrow has already done the conversion by the time
 * `toJSON` hands the value over. Observed directly on duckdb-wasm 1.33: unit 2, value
 * 1753529375000, which is milliseconds.
 *
 * If a future version changes that, the cross-lane equality check fails loudly on the
 * next run rather than publishing a wrong date - which is the reason the gate exists.
 */
function toIso(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date || typeof value === 'string') return value;

  const millis = toBigInt(value);
  return millis === undefined ? value : new Date(Number(millis)).toISOString();
}

function toBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);

  // Arrow hands wide decimals back as little-endian 32-bit words.
  if (value instanceof Uint32Array) {
    let combined = 0n;
    for (let i = value.length - 1; i >= 0; i--) combined = (combined << 32n) | BigInt(value[i]!);
    // Two's complement: the top bit of the most significant word is the sign.
    const width = BigInt(value.length) * 32n;
    return combined >> (width - 1n) === 1n ? combined - (1n << width) : combined;
  }
  return undefined;
}
