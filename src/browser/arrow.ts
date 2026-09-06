/**
 * Turning an Arrow result into the plain rows the normaliser expects.
 *
 * DuckDB-WASM's `Row.toJSON()` returns a DECIMAL as its unscaled integer, so revenue
 * of 3,237,919.01 arrives as 323791901 and nothing throws. The scale is in the Arrow
 * schema, so it is read from there rather than guessed. Timestamps are here for a
 * related reason: they arrive as bare epoch integers.
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
    /*
     * Structural checks rather than Arrow's Type enum, so a different apache-arrow
     * major does not break this. Decimal is the only Arrow type carrying both scale
     * and precision; Timestamp is the only one carrying both unit and timezone.
     */
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
 * Arrow timestamps arrive already normalised to epoch milliseconds, whatever unit the
 * schema declares. DuckDB says MICROSECOND and hands over milliseconds; rescaling by
 * the declared unit put a July 2025 order in January 1970. Observed on duckdb-wasm
 * 1.33: unit 2, value 1753529375000.
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
