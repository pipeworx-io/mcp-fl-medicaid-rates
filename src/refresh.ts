/**
 * The refresh loop for the Florida Medicaid rates stored copy (fleet #3614, #3617).
 *
 * ONE implementation, two callers: `scripts/refresh-rates.mjs` (an operator on a US machine, writing R2 with
 * wrangler or a directory) and `workers/fl-rates-refresh` (a scheduled Worker placed in the US, writing R2
 * through its binding). Both hand this function the same parser and their own I/O, so the copy is produced by
 * exactly the same steps wherever it runs.
 *
 * No imports and no runtime-specific API beyond `crypto.subtle` (Node 20+ and Workers both have it), so it loads
 * under node's type stripping and under the Workers bundler alike. The parse functions arrive in `kit` because
 * node cannot resolve this package's `./parse.js` specifiers and a bundler cannot resolve `./parse.ts` ones.
 *
 * RESULT, not exit code. `ok` is true only when every schedule in scope was read, parsed, cleared its row floor,
 * and (unless dryRun) the manifest landed. The manifest is written LAST: any failure leaves the previous manifest
 * in place, so `copy_refreshed_at` never claims a check that did not happen.
 */

type Row = Record<string, string | number | null>;
type TableLike = { columns: string[]; rows: Row[]; zeroCells: Record<string, number> };
type FileRefLike = { url: string; effective: string | null };
type ScheduleLike = { page: string; minRows: number };

export interface RefreshKit {
  HOST: string;
  SCHEDULES: Record<string, ScheduleLike>;
  parsePage(html: string): FileRefLike[];
  selectFiles(all: FileRefLike[], sch: never): FileRefLike[];
  parseTable(bytes: Uint8Array, parseXlsx: never): Promise<TableLike>;
  parseXlsx: unknown;
  periodLabel(effective: string | null): string | null;
}

export interface RefreshIO {
  /** Read one URL from the agency. Throws on a non-2xx. */
  get(url: string): Promise<Uint8Array>;
  /** Read an object under the store prefix; null when absent. */
  readObj(key: string): Promise<string | null>;
  /** Write an object under the store prefix. */
  putObj(key: string, body: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  err(line: string): void;
}

export interface RefreshOpts {
  only?: Set<string> | null;
  force?: boolean;
  dryRun?: boolean;
  delayMs: number;
}

export interface RefreshResult {
  ok: boolean;
  written: number;
  unchanged: number;
  rowsTotal: number;
  fileCount: number;
  failures: string[];
  /** The manifest's refreshed_at after this run (the new one when it advanced, the old one when it did not). */
  refreshedAt: string | null;
  priorRefreshedAt: string | null;
  advanced: boolean;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const safe = (name: string) => name.replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_');

/** Age in whole days of the stored copy's last successful refresh; null when there is no readable manifest. */
export async function storedCopyAgeDays(io: Pick<RefreshIO, 'readObj'>, nowMs: number): Promise<{ refreshedAt: string | null; ageDays: number | null }> {
  try {
    const m = JSON.parse((await io.readObj('_manifest.json')) ?? 'null') as { refreshed_at?: unknown } | null;
    const at = typeof m?.refreshed_at === 'string' ? Date.parse(m.refreshed_at) : NaN;
    if (Number.isNaN(at)) return { refreshedAt: null, ageDays: null };
    return { refreshedAt: m!.refreshed_at as string, ageDays: Math.floor((nowMs - at) / 86_400_000) };
  } catch {
    return { refreshedAt: null, ageDays: null };
  }
}

export async function refreshRates(io: RefreshIO, kit: RefreshKit, opts: RefreshOpts): Promise<RefreshResult> {
  const ids = Object.keys(kit.SCHEDULES).filter((i) => !opts.only || opts.only.has(i));
  if (!ids.length) throw new Error(`--only matched no schedule (valid: ${Object.keys(kit.SCHEDULES).join(', ')})`);

  let prior: { refreshed_at?: string; files?: Record<string, { hash?: string; retrieved_at?: string }>; schedules?: Record<string, unknown[]> } = {};
  try { prior = JSON.parse((await io.readObj('_manifest.json')) ?? '{}'); } catch { prior = {}; }
  const priorFiles = prior.files ?? {};
  const schedules: Record<string, Array<{ key: string; name: string; effective: string | null; retrieved_at: string; rows: number }>> =
    { ...((prior.schedules ?? {}) as Record<string, Array<{ key: string; name: string; effective: string | null; retrieved_at: string; rows: number }>>) };
  const files: Record<string, { hash: string; rows: number; retrieved_at: string }> = { ...(priorFiles as Record<string, { hash: string; rows: number; retrieved_at: string }>) };

  const pages = new Map<string, FileRefLike[]>();
  const bytesCache = new Map<string, Uint8Array>();
  const failures: string[] = [];
  let written = 0, unchanged = 0, rowsTotal = 0;
  const startedAt = new Date().toISOString();

  for (const id of ids) {
    const sch = kit.SCHEDULES[id];
    try {
      if (!pages.has(sch.page)) {
        await io.sleep(opts.delayMs);
        pages.set(sch.page, kit.parsePage(new TextDecoder().decode(await io.get(`${kit.HOST}/medicaid/cost-reimbursement/${sch.page}.html`))));
      }
      const refs = kit.selectFiles(pages.get(sch.page)!, sch as never);
      if (!refs.length) throw new Error('no workbook on the page matches this schedule');
      const entries: Array<{ key: string; name: string; effective: string | null; retrieved_at: string; rows: number }> = [];
      for (const ref of refs) {
        const name = decodeURIComponent(ref.url.split('/').pop()!);
        if (!bytesCache.has(ref.url)) { await io.sleep(opts.delayMs); bytesCache.set(ref.url, await io.get(ref.url)); }
        const table = await kit.parseTable(bytesCache.get(ref.url)!, kit.parseXlsx as never);
        const isLatest = ref === refs[0];
        if (isLatest && table.rows.length < sch.minRows) {
          throw new Error(`latest table ${name} has ${table.rows.length} provider rows, below the ${sch.minRows} floor - refusing a partial read`);
        }
        const key = `files/${safe(name)}.json`;
        const hash = await sha256Hex(JSON.stringify({ c: table.columns, r: table.rows, z: table.zeroCells }));
        const same = !opts.force && priorFiles[key]?.hash === hash;
        let retrievedAt = priorFiles[key]?.retrieved_at ?? startedAt;
        if (same) { unchanged += 1; } else {
          retrievedAt = startedAt;
          if (!opts.dryRun) {
            await io.putObj(key, JSON.stringify({ name, effective: ref.effective, retrieved_at: retrievedAt, columns: table.columns, rows: table.rows, zeroCells: table.zeroCells }));
          }
          written += 1;
        }
        files[key] = { hash, rows: table.rows.length, retrieved_at: retrievedAt };
        rowsTotal += table.rows.length;
        entries.push({ key, name, effective: ref.effective, retrieved_at: retrievedAt, rows: table.rows.length });
      }
      schedules[id] = entries;
      io.log(`refresh-rates: ${id}: ${entries.length} file(s), latest ${kit.periodLabel(entries[0].effective) ?? 'undated'} with ${entries[0].rows} provider rows`);
    } catch (e) {
      failures.push(`${id}: ${(e as Error).message}`);
      io.err(`refresh-rates: FAILED ${id}: ${(e as Error).message}`);
    }
  }

  const fileCount = Object.values(schedules).reduce((a, v) => a + v.length, 0);
  io.log(`refresh-rates: ${ids.length} schedule(s) in scope; ${fileCount} stored file(s) listed; ${written} written, ${unchanged} unchanged; ${rowsTotal} provider rows read this run`);
  const base = { written, unchanged, rowsTotal, fileCount, failures, priorRefreshedAt: prior.refreshed_at ?? null };
  if (failures.length) {
    io.err(`refresh-rates: RED - ${failures.length} schedule(s) failed; manifest NOT advanced (copy_refreshed_at stays at ${prior.refreshed_at ?? 'never'})`);
    return { ...base, ok: false, refreshedAt: prior.refreshed_at ?? null, advanced: false };
  }
  if (opts.dryRun) {
    io.log('refresh-rates: DRY RUN complete - nothing written.');
    return { ...base, ok: true, refreshedAt: prior.refreshed_at ?? null, advanced: false };
  }
  const manifest = {
    jurisdiction: 'fl',
    source: 'Florida AHCA, Medicaid cost reimbursement rate schedules',
    refreshed_at: startedAt,
    schedule_count: Object.keys(schedules).length,
    file_count: fileCount,
    schedules,
    files,
  };
  await io.putObj('_manifest.json', JSON.stringify(manifest));
  io.log(`refresh-rates: manifest written (refreshed_at ${startedAt}); GREEN`);
  return { ...base, ok: true, refreshedAt: startedAt, advanced: true };
}
