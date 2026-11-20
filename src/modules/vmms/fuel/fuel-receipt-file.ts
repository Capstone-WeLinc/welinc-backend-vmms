import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { extname } from 'node:path';
import { MAX_FUEL_RECEIPT_BYTES } from './fuel.constants';

export type FuelReceiptFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function validateFuelReceiptFile(file: FuelReceiptFile | undefined) {
  if (!file?.buffer?.length)
    throw new BadRequestException('Select a JPG, JPEG, or PNG receipt image.');
  if (file.buffer.length > MAX_FUEL_RECEIPT_BYTES)
    throw new PayloadTooLargeException(
      'Fuel receipt images must be 10 MB or smaller.',
    );

  const extension = extname(file.originalname).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION[extension];
  const actualMime = file.buffer
    .subarray(0, 3)
    .equals(Buffer.from([0xff, 0xd8, 0xff]))
    ? 'image/jpeg'
    : file.buffer
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'image/png'
      : null;

  if (
    !expectedMime ||
    expectedMime !== file.mimetype.toLowerCase() ||
    expectedMime !== actualMime
  ) {
    throw new BadRequestException(
      'Receipt must be a valid JPG, JPEG, or PNG image.',
    );
  }
  return { extension, contentType: expectedMime };
}
