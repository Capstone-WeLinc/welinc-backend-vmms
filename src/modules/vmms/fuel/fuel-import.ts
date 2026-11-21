import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export type ParsedFuelImportRow = {
  key: string;
  sheetName: string;
  worksheetRow: number;
  plateNumber: string;
  date: string;
  odometer: number | null;
  poNumber: string;
  siNumber: string;
  product: string;
  liters: number | null;
  pricePerLiter: number | null;
};

const MAX_IMPORT_ROWS = 1000;
const SUMMARY_ROW_LABEL =
  /^\s*(?:grand\s+total|sub\s*total|less\s+amount|total(?:\s+(?:amount(?:\s+(?:to\s+be\s+paid|payable|due|to\s+pay))?|to\s+be\s+paid|payable|due|lit(?:er|re)s?|quantity|volume|fuel))?|amount\s+(?:to\s+be\s+paid|payable|due|to\s+pay))(?:\s*[:\-]?\s*(?:php|p|₱)?\s*[\d,.()\-]+)?\s*[:\-]?\s*$/i;
const HEADER_ALIASES = {
  date: ['date', 'transaction date'],
  plateNumber: ['plate no', 'plate number', 'plate'],
  odometer: ['odometer', 'odometer reading', 'odometer reading km'],
  poNumber: ['po number', 'p o number', 'purchase order number', 'po no'],
  siNumber: ['si number', 's i number', 'sales invoice number', 'si no'],
  product: ['product', 'fuel type'],
  liters: ['liters', 'litres', 'liter', 'litre'],
  pricePerLiter: ['unit price', 'price per liter', 'price per litre'],
} as const;

type Column = keyof typeof HEADER_ALIASES;

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) {
    if ('result' in value) return value.result;
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('richText' in value && Array.isArray(value.richText))
      return value.richText.map((item) => item.text).join('');
  }
  return value;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateText(value);
  return String(value).trim();
}

function dateText(date: Date): string {
  return datePartsText(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function datePartsText(year: number, month: number, day: number): string {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 1 ||
    year > 9999
  )
    return '';
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDate(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return dateText(value);
  if (typeof value === 'number' && value > 20_000 && value < 100_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return dateText(date);
  }
  const raw = text(value);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso)
    return datePartsText(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (slash) {
    const year = Number(slash[3]) < 100
      ? Number(slash[3]) + (Number(slash[3]) < 70 ? 2000 : 1900)
      : Number(slash[3]);
    return datePartsText(year, Number(slash[2]), Number(slash[1]));
  }
  const named = /^(\d{1,2})[-\s]([a-z]{3,})[-\s,](\d{2,4})$/i.exec(raw);
  if (named) {
    const months = [
      'jan', 'feb', 'mar', 'apr', 'may', 'jun',
      'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    ];
    const month = months.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      const shortYear = Number(named[3]);
      const year = shortYear < 100
        ? shortYear + (shortYear < 70 ? 2000 : 1900)
        : shortYear;
      return datePartsText(year, month + 1, Number(named[1]));
    }
  }
  return '';
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null;
  const raw = text(value).replace(/[₱,\s]/g, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHeader(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlateNumber(value: string): boolean {
  return /^[A-Z]{1,6}[- ]?\d{1,6}[A-Z]?$/i.test(value.trim());
}

function isSummaryRow(row: ExcelJS.Row): boolean {
  let summary = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (SUMMARY_ROW_LABEL.test(text(cellValue(cell.value)))) summary = true;
  });
  return summary;
}

function headerColumns(
  worksheet: ExcelJS.Worksheet,
): { rowNumber: number; columns: Partial<Record<Column, number>> } | null {
  for (let rowNumber = 1; rowNumber <= Math.min(worksheet.rowCount, 40); rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const columns: Partial<Record<Column, number>> = {};
    for (let column = 1; column <= worksheet.columnCount; column++) {
      const header = normalizeHeader(cellValue(row.getCell(column).value));
      for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<[Column, readonly string[]]>) {
        if (aliases.some((alias) => normalizeHeader(alias) === header))
          columns[field] = column;
      }
    }
    if (columns.date && columns.plateNumber && columns.liters && columns.pricePerLiter)
      return { rowNumber, columns };
  }
  return null;
}

export async function parseFuelImportWorkbook(
  buffer: Buffer,
): Promise<{ rows: ParsedFuelImportRow[]; skippedSheets: string[] }> {
  let workbook: ExcelJS.Workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
  } catch {
    throw new BadRequestException('Upload a readable .xlsx fuel statement workbook.');
  }

  const rows: ParsedFuelImportRow[] = [];
  const skippedSheets: string[] = [];
  for (const worksheet of workbook.worksheets) {
    const header = headerColumns(worksheet);
    if (!header) {
      let hasValues = false;
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.value !== null && cell.value !== undefined && cell.value !== '')
            hasValues = true;
        });
      });
      if (hasValues) skippedSheets.push(worksheet.name);
      continue;
    }
    for (let rowNumber = header.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (isSummaryRow(row)) continue;
      const value = (column: Column) => {
        const index = header.columns[column];
        return index ? cellValue(row.getCell(index).value) : null;
      };
      const plateNumber = text(value('plateNumber'));
      const date = parseDate(value('date'));
      const liters = parseNumber(value('liters'));
      const pricePerLiter = parseNumber(value('pricePerLiter'));
      const odometer = parseNumber(value('odometer'));
      const validPlate = isPlateNumber(plateNumber);
      const hasNumericMeasurement =
        odometer !== null || liters !== null || pricePerLiter !== null;
      const hasFuelAmounts =
        liters !== null &&
        liters > 0 &&
        pricePerLiter !== null &&
        pricePerLiter > 0;
      if (
        !(
          (validPlate && date) ||
          (validPlate && hasNumericMeasurement) ||
          (date && hasFuelAmounts)
        )
      )
        continue;

      rows.push({
        key: `${worksheet.name}:${rowNumber}`,
        sheetName: worksheet.name,
        worksheetRow: rowNumber,
        plateNumber,
        date,
        odometer,
        poNumber: text(value('poNumber')),
        siNumber: text(value('siNumber')),
        product: text(value('product')),
        liters,
        pricePerLiter,
      });
      if (rows.length > MAX_IMPORT_ROWS)
        throw new BadRequestException(
          `Import at most ${MAX_IMPORT_ROWS.toLocaleString()} fill-up rows per workbook.`,
        );
    }
  }
  if (!rows.length)
    throw new BadRequestException(
      'No fuel rows were found. Worksheets need Date, Plate No., Liters, and Unit Price columns.',
    );
  return { rows, skippedSheets };
}
