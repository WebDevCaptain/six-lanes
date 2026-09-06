import 'server-only';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PATHS } from '@/config';
import type { SliceManifest } from '@/browser/slice';

/**
 * Reads the slice manifest at request time.
 *
 * Returns null rather than throwing when the slice has not been built. The server
 * lanes work without it, so the page should still render and say what is missing -
 * a blank screen is a worse answer than "run `pnpm slice`".
 */
export async function readSliceManifest(): Promise<SliceManifest | null> {
  try {
    return JSON.parse(await readFile(join(PATHS.slice, 'manifest.json'), 'utf8')) as SliceManifest;
  } catch {
    return null;
  }
}
