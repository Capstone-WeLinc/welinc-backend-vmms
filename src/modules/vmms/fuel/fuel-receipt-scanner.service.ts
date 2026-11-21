import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultAzureCredential } from '@azure/identity';
import type { Env } from '../../../config/env';
import {
  type FuelReceiptFile,
  validateFuelReceiptFile,
} from './fuel-receipt-file';

const API_VERSION = '2024-11-30';
const MAX_SCAN_DURATION_MS = 30_000;
const MAX_SCANS_PER_ACTOR_PER_MINUTE = 5;
const MAX_CONCURRENT_SCANS = 2;
const DOCUMENT_INTELLIGENCE_SCOPE =
  'https://cognitiveservices.azure.com/.default';

type JsonRecord = Record<string, unknown>;

export type FuelReceiptSuggestion<T> = {
  value: T | null;
  confidence: number | null;
  needsReview: boolean;
};

export type FuelReceiptScanResult = {
  merchantName: FuelReceiptSuggestion<string>;
  date: FuelReceiptSuggestion<string>;
  liters: FuelReceiptSuggestion<number>;
  pricePerLiter: FuelReceiptSuggestion<number>;
  printedTotal: FuelReceiptSuggestion<number>;
};

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function confidenceOf(field: unknown): number | null {
  const confidence = record(field)?.confidence;
  return typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
    ? confidence
    : null;
}

function suggestion<T>(
  value: T | null,
  confidence: number | null,
): FuelReceiptSuggestion<T> {
  return {
    value,
    confidence,
    needsReview: value === null || confidence === null || confidence < 0.85,
  };
}

function stringValue(field: unknown): string | null {
  const value = record(field)?.valueString;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(field: unknown): number | null {
  const value = record(field);
  if (!value) return null;
  const currency = record(value.valueCurrency);
  const currencyCode =
    typeof currency?.currencyCode === 'string'
      ? currency.currencyCode.toUpperCase()
      : null;
  if (currencyCode && !['PHP', '₱'].includes(currencyCode)) return null;
  const currencyAmount = currency?.amount;
  const raw =
    typeof value.valueNumber === 'number'
      ? value.valueNumber
      : typeof currencyAmount === 'number'
        ? currencyAmount
        : value.valueString;
  const parsed =
    typeof raw === 'string' ? Number(raw.replace(/,/g, '').trim()) : raw;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function dateValue(field: unknown): string | null {
  const value = record(field)?.valueDate;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function minimumConfidence(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length !== values.length || present.length === 0) return null;
  return Math.min(...present);
}

function getFuelLineSuggestions(fields: JsonRecord) {
  const items = record(fields.Items)?.valueArray;
  if (!Array.isArray(items))
    return { liters: null, pricePerLiter: null, confidence: null };

  const candidates = items.flatMap((item) => {
    const itemFields = record(record(item)?.valueObject);
    if (!itemFields) return [];
    const description = stringValue(itemFields.Description) ?? '';
    if (
      !/\b(diesel|gasoline|petrol|unleaded|premium|fuel)\b/i.test(description)
    )
      return [];

    const quantity = numberValue(itemFields.Quantity);
    const priceField = itemFields.Price ?? itemFields.UnitPrice;
    const price = numberValue(priceField);
    if (quantity === null || price === null || quantity <= 0 || price <= 0)
      return [];
    return [
      {
        quantity,
        price,
        confidence: minimumConfidence([
          confidenceOf(itemFields.Quantity),
          confidenceOf(priceField),
        ]),
      },
    ];
  });

  if (!candidates.length)
    return { liters: null, pricePerLiter: null, confidence: null };
  const unitPrice = candidates[0].price;
  if (
    candidates.some(
      (candidate) => Math.abs(candidate.price - unitPrice) >= 0.005,
    )
  )
    return { liters: null, pricePerLiter: null, confidence: null };

  return {
    liters: candidates.reduce(
      (total, candidate) => total + candidate.quantity,
      0,
    ),
    pricePerLiter: unitPrice,
    confidence: minimumConfidence(
      candidates.map((candidate) => candidate.confidence),
    ),
  };
}

function mapReceiptResult(payload: unknown): FuelReceiptScanResult {
  const analyzeResult = record(record(payload)?.analyzeResult);
  const documents = analyzeResult?.documents;
  const fields = Array.isArray(documents)
    ? record(record(documents[0])?.fields)
    : undefined;
  if (!fields)
    throw new BadRequestException(
      'The receipt could not be read. Enter the fuel details manually.',
    );

  const merchant = fields.MerchantName;
  const transactionDate = fields.TransactionDate;
  const total = fields.Total;
  const fuelLines = getFuelLineSuggestions(fields);
  const result = {
    merchantName: suggestion(stringValue(merchant), confidenceOf(merchant)),
    date: suggestion(dateValue(transactionDate), confidenceOf(transactionDate)),
    liters: suggestion(fuelLines.liters, fuelLines.confidence),
    pricePerLiter: suggestion(fuelLines.pricePerLiter, fuelLines.confidence),
    printedTotal: suggestion(numberValue(total), confidenceOf(total)),
  };
  if (Object.values(result).every((field) => field.value === null))
    throw new BadRequestException(
      'No fuel details were recognized. Enter the fuel details manually.',
    );
  return result;
}

function unavailable(
  message = 'Receipt scanning is temporarily unavailable. Enter the fuel details manually.',
) {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'RECEIPT_SCAN_UNAVAILABLE',
    message,
  });
}

@Injectable()
export class FuelReceiptScannerService {
  private readonly logger = new Logger(FuelReceiptScannerService.name);
  private readonly credential = new DefaultAzureCredential();
  private activeScans = 0;
  private readonly scanTimes = new Map<string, number[]>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  async scan(
    file: FuelReceiptFile | undefined,
    actorId: string,
  ): Promise<FuelReceiptScanResult> {
    if (!file)
      throw new BadRequestException(
        'Select a JPG, JPEG, or PNG receipt image.',
      );
    validateFuelReceiptFile(file);
    const endpoint = this.config
      .get('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', { infer: true })
      ?.replace(/\/+$/, '');
    const key = this.config
      .get('AZURE_DOCUMENT_INTELLIGENCE_KEY', { infer: true })
      ?.trim();
    if (!endpoint)
      throw unavailable(
        'Receipt scanning is not configured. Enter the fuel details manually.',
      );

    this.reserveScan(actorId);
    try {
      const base = new URL(endpoint);
      const azureHost =
        base.hostname.endsWith('.cognitiveservices.azure.com') ||
        base.hostname.endsWith('.cognitiveservices.azure.us') ||
        base.hostname.endsWith('.cognitiveservices.azure.cn');
      if (base.protocol !== 'https:' || !azureHost) throw unavailable();
      const authHeaders = key
        ? { 'Ocp-Apim-Subscription-Key': key }
        : await this.identityAuthHeaders();
      const analyzeUrl = new URL(
        `/documentintelligence/documentModels/prebuilt-receipt:analyze?_overload=analyzeDocument&api-version=${API_VERSION}`,
        base,
      );
      const analyzeResponse = await this.request(analyzeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ base64Source: file.buffer.toString('base64') }),
      });
      if (analyzeResponse.status === 400 || analyzeResponse.status === 415)
        throw new BadRequestException(
          'The receipt image could not be read. Choose another image or enter the fuel details manually.',
        );
      if (analyzeResponse.status !== 202) throw unavailable();

      const operationLocation =
        analyzeResponse.headers.get('operation-location');
      if (!operationLocation) throw unavailable();
      const operationUrl = new URL(operationLocation, base);
      if (
        operationUrl.protocol !== 'https:' ||
        operationUrl.origin !== base.origin
      )
        throw unavailable();

      const result = await this.poll(operationUrl, authHeaders);
      return mapReceiptResult(result);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof TypeError ||
        error instanceof DOMException ||
        error instanceof SyntaxError
      ) {
        this.logger.warn('Receipt extraction failed; no image was retained.');
        throw unavailable();
      }
      throw error;
    } finally {
      this.activeScans -= 1;
    }
  }

  private async identityAuthHeaders(): Promise<Record<string, string>> {
    try {
      const token = await this.credential.getToken(
        DOCUMENT_INTELLIGENCE_SCOPE,
      );
      if (!token?.token) throw unavailable();
      return { Authorization: `Bearer ${token.token}` };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.warn(
        'Receipt scanning identity authentication failed; no image was retained.',
      );
      throw unavailable(
        'Receipt scanning authentication is unavailable. Enter the fuel details manually.',
      );
    }
  }

  private reserveScan(actorId: string) {
    const now = Date.now();
    for (const [id, timestamps] of this.scanTimes) {
      const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (recent.length) this.scanTimes.set(id, recent);
      else this.scanTimes.delete(id);
    }

    const actorScans = this.scanTimes.get(actorId) ?? [];
    if (actorScans.length >= MAX_SCANS_PER_ACTOR_PER_MINUTE)
      throw new HttpException(
        'Too many receipt scans. Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (this.activeScans >= MAX_CONCURRENT_SCANS)
      throw new HttpException(
        'Receipt scanning is busy. Try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    actorScans.push(now);
    this.scanTimes.set(actorId, actorScans);
    this.activeScans += 1;
  }

  private async poll(
    operationUrl: URL,
    authHeaders: Record<string, string>,
  ): Promise<unknown> {
    const deadline = Date.now() + MAX_SCAN_DURATION_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await this.request(operationUrl, {
        method: 'GET',
        headers: authHeaders,
      });
      if (!response.ok) throw unavailable();
      const payload: unknown = await response.json();
      const status = record(payload)?.status;
      if (status === 'succeeded') return payload;
      if (status === 'failed') throw unavailable();
      if (status !== 'running' && status !== 'notStarted') throw unavailable();
    }
    throw unavailable(
      'Receipt scanning took too long. Enter the fuel details manually.',
    );
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
