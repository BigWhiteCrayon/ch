// What a model could not do because nothing it had covered it, kept for working
// out afterwards which capabilities are worth adding. One row per report, in a
// CSV file beside the log (see log.directory) so that it opens in a spreadsheet
// or reads into a script; every cell is quoted, since what the user asked for
// has commas and line breaks in it.
//
// The columns that say what was missing and what the user wanted come first
// after the time; the rest says where it happened.

import fs from 'fs';
import path from 'path';
import * as log from './log';

export const FILE_NAME = 'missing-capabilities.csv';

export const COLUMNS = [
  'time',
  'capability',
  'user_goal',
  'detail',
  'last_user_message',
  'thread',
  'workspace',
  'model',
  'phase',
  'agent',
] as const;

export type Column = (typeof COLUMNS)[number];
export type Report = Partial<Record<Exclude<Column, 'time'>, string | undefined>>;

// A cell that starts with one of these would be run as a formula if the file is
// opened in a spreadsheet, so it gets a leading apostrophe to stop that.
const FORMULA_START = /^[=+\-@\t\r]/;

const cell = (value: string | undefined) => {
  const text = value ?? '';
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

// Adds one report to the file, with the header first if the file is new. Nothing
// is kept until the log has been started, and a report that can't be written is
// logged rather than thrown, since the model has nothing to do about it.
export function record(report: Report): void {
  const dir = log.directory();
  if (!dir) return;
  try {
    const file = path.join(dir, FILE_NAME);
    const header = fs.existsSync(file) ? '' : `${COLUMNS.join(',')}\n`;
    const time = new Date().toISOString();
    const row = COLUMNS.map((column) => cell(column === 'time' ? time : report[column])).join(',');
    fs.appendFileSync(file, `${header}${row}\n`, { mode: 0o600 });
    log.info('capability.missing', { capability: report.capability });
  } catch (err) {
    log.error('capability.failed', { error: err });
  }
}
