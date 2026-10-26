/**
 * Pure parsing for the Florida AHCA rate pages and workbooks. No imports, so the refresh script
 * (scripts/refresh-rates.mjs, run under node) and the Worker use ONE parser: the stored copy is
 * produced by exactly the code that would have read the agency live.
 */

import type { Workbook as XlsxBook } from './xlsx.js';

export const HOST = 'https://ahca.myflorida.com';

export type Schedule = {
  page: string;
  label: string;
  file: RegExp;
  exclude?: RegExp;
  /** Floor for the LATEST file's provider rows. Below it the read is treated as partial and refused. */
  minRows: number;
  /** What the published table covers, when that is narrower than its heading suggests. */
  scope?: string;
};

export const SCHEDULES: Record<string, Schedule> = {
  fqhc: { page: 'fqhc-rhc-rates', label: 'Federally Qualified Health Center (FQHC) per-visit PPS encounter rate', file: /^FQHC[_ ]Rates/i, minRows: 300 },
  rhc: { page: 'fqhc-rhc-rates', label: 'Rural Health Clinic (RHC) per-visit PPS encounter rate', file: /^RHC[_ ]Rates/i, minRows: 80 },
  pb_rhc: { page: 'fqhc-rhc-rates', label: 'Provider-based Rural Health Clinic per-visit rate', file: /^PB-RHC[_ ]Rates/i, minRows: 8 },
  snu: { page: 'skilled-nursing-unit-snu-rates', label: 'Skilled nursing unit per diem rate', file: /SNU[_ ]Rates/i, minRows: 2,
    scope: 'The agency posts per diem rates for the hospital-based skilled nursing units it lists in this table (3 units in the October 2026 table); it is the complete published table, not a sample, and it is not a list of every nursing facility -- see the nursing_home schedule for those.' },
  swing_bed: { page: 'swing-bed-rates', label: 'Swing bed per diem rate', file: /SB[_ ]Rates/i, minRows: 4 },
  hospice_level_of_care: { page: 'hospice-care-services-per-diem-rates', label: 'Hospice level-of-care per diem rates', file: /Hospice[_ ]LOC[_ ]Rates/i, minRows: 40 },
  hospice_room_board: { page: 'hospice-room-board-rates', label: 'Hospice nursing home room and board rate', file: /Hospice[_ ]R-B[_ ]Rates/i, minRows: 40 },
  nursing_home: { page: 'nursing-home-rates', label: 'Nursing home final per diem rate', file: /NH[_ ]Final[_ ]Rates/i, exclude: /detail/i, minRows: 400 },
  hospital: {
    page: 'hospital-rates-ambulatory-surgical-centers',
    label: 'State mental health hospital per diem rates',
    file: /Hospital[_ ]Rates/i,
    minRows: 3,
    scope:
      'STATE MENTAL HEALTH HOSPITALS ONLY. Since July 2013 the agency pays community-hospital inpatient stays by diagnosis-related group, and since July 2017 outpatient by enhanced ambulatory patient group; it posts no per diem for those hospitals. The only hospitals still paid a per diem, and so the only rows in this table, are the state mental health hospitals (3 in the July 2026 table). A community hospital is not missing from the data -- it is not in this schedule. Per diem columns that read 0 mean no per diem is paid for that service (null here).',
  },
};
export const SCHEDULE_IDS = Object.keys(SCHEDULES);

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const MONTH_NAMES = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

export function iso(y: number, m: number, d = 1): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Effective date implied by a published file's name (first day of the semester). */
export function effectiveFromName(name: string): string | null {
  let m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[_ ]+(\d{4})/i.exec(name);
  if (m) return iso(+m[2], MONTHS.findIndex((x) => x.startsWith(m![1].toLowerCase())) + 1);
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /(?<!\d)(\d{1,2})-(\d{1,2})-(\d{4})/.exec(name);
  if (m) return iso(+m[3], +m[1], +m[2]);
  m = /(\d{4})-(\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[1], +m[2]);
  m = /(?<!\d)(20\d{2})(\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[1], +m[2]);
  m = /(?<!\d)(\d{1,2})-(20\d{2})(?!\d)/.exec(name);
  if (m) return iso(+m[2], +m[1]);
  return null;
}

export function periodLabel(effective: string | null): string | null {
  if (!effective) return null;
  const [y, mo] = effective.split('-');
  return `${MONTH_NAMES[+mo - 1]} ${y}`;
}


export type FileRef = { url: string; effective: string | null };
export function parsePage(html: string): FileRef[] {
  const files: FileRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+\.xlsx)"/gi)) {
    let url: string;
    try { url = new URL(m[1].replace(/ /g, '%20'), `${HOST}/medicaid/cost-reimbursement/`).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    files.push({ url, effective: effectiveFromName(decodeURIComponent(url.split('/').pop() ?? '')) });
  }
  if (!files.length) throw new Error('Florida AHCA rate page listed no workbooks -- the page layout may have changed');
  return files;
}


export type Table = { columns: string[]; rows: Record<string, string | number | null>[]; zeroCells: Record<string, number> };

export function clean(v: string | number | undefined): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export async function parseTable(bytes: Uint8Array, parseXlsx: (b: Uint8Array) => Promise<XlsxBook>): Promise<Table> {
  const wb = await parseXlsx(bytes);
  // Refuse a partial read rather than answer from whatever rows survived.
  if (wb.unreadSheets.length) throw new Error(`Florida AHCA rate file has sheet(s) this reader could not open (${wb.unreadSheets.join(', ')}) -- refusing to answer from a partial read`);
  for (const sh of wb.sheets) {
    if (sh.cellsRead !== sh.cellsDeclared) throw new Error(`Florida AHCA rate file sheet "${sh.name}" is incompletely read (${sh.cellsRead} of ${sh.cellsDeclared} cells) -- refusing to answer from a partial read`);
  }
  const columns: string[] = [];
  const rows: Record<string, string | number | null>[] = [];
  const multi = wb.sheets.length > 1;
  for (const sh of wb.sheets) {
    const rowNums = [...sh.rows.keys()].sort((a, b) => a - b);
    let headerRow = -1;
    for (const rn of rowNums.slice(0, 12)) {
      const cells = [...sh.rows.get(rn)!.values()];
      if (cells.length >= 3 && cells.every((c) => typeof c === 'string')) { headerRow = rn; break; }
    }
    if (headerRow < 0) {
      if (sh.cellsRead > 0) throw new Error(`Florida AHCA rate file sheet "${sh.name}" has data but no recognisable header row -- layout may have changed; refusing to answer from a partial read`);
      continue;
    }
    const hdr = sh.rows.get(headerRow)!;
    const letters = [...hdr.keys()];
    const names = new Map<string, string>();
    for (const L of letters) {
      let n = clean(hdr.get(L));
      if (!n) continue;
      let k = n, i = 2;
      while (names.has(k) && names.get(k) !== L) k = `${n} (${i++})`;
      names.set(L, k);
      if (!columns.includes(k)) columns.push(k);
    }
    for (const rn of rowNums) {
      if (rn <= headerRow) continue;
      const r = sh.rows.get(rn)!;
      const rec: Record<string, string | number> = {};
      let numeric = 0;
      for (const L of letters) {
        const v = r.get(L);
        if (v === undefined) continue;
        const name = names.get(L);
        if (!name) continue;
        rec[name] = typeof v === 'string' ? clean(v) : v;
        if (typeof v === 'number') numeric++;
      }
      if (numeric === 0 && Object.keys(rec).length < 2) continue;
      if (multi) rec['Sheet'] = sh.name;
      rows.push(rec);
    }
  }
  if (multi && !columns.includes('Sheet')) columns.push('Sheet');
  // Excel serial dates in an "effective date" column -> ISO.
  for (const c of columns) {
    if (!/date/i.test(c)) continue;
    for (const r of rows) {
      const v = r[c];
      if (typeof v === 'number' && v > 30000 && v < 80000) r[c] = new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }
  }
  if (!rows.length) throw new Error('Florida AHCA rate file parsed to zero rows -- layout may have changed');
  // The agency states money to the cent; some workbooks store float noise (159.18499999999997).
  // Round half-up to cents at this one boundary, in every rate column of every schedule.
  // A 0 in a rate column is the agency's "no rate for this service", not a price: null it.
  const zeroCells: Record<string, number> = {};
  for (const c of columns) {
    if (isIdColumn(c)) continue;
    for (const r of rows) {
      const v = r[c];
      if (typeof v !== 'number') continue;
      if (v === 0) { (r as Record<string, string | number | null>)[c] = null; zeroCells[c] = (zeroCells[c] ?? 0) + 1; continue; }
      r[c] = Math.round(v * 100 + 1e-6) / 100;
    }
  }
  return { columns, rows, zeroCells };
}

export function isIdColumn(name: string): boolean {
  return /number|^id$|npi|provider|medicaid no|name|sheet|date|^#$/i.test(name);
}

/** The workbooks on a rate page that belong to one schedule, newest semester first. */
export function selectFiles(all: FileRef[], sch: Schedule): FileRef[] {
  return all
    .filter((f) => {
      const n = decodeURIComponent(f.url.split('/').pop() ?? '');
      return sch.file.test(n) && !(sch.exclude && sch.exclude.test(n));
    })
    .sort((a, b) => (b.effective ?? '').localeCompare(a.effective ?? ''));
}
