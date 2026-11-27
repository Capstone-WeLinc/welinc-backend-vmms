import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import { extname } from 'node:path';
import {
  MAX_FUEL_RECEIPT_BYTES,
  MAX_FUEL_RECEIPT_PIXELS,
  MAX_FUEL_RECEIPT_SIDE_PX,
} from './fuel.constants';

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
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const DIMENSION_LIMIT_MESSAGE =
  'Receipt images must be no larger than 8,000 pixels on either side or 20 megapixels total.';

export async function validateFuelReceiptFile(
  file: FuelReceiptFile | undefined,
): Promise<{ extension: string; contentType: string }> {
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
  const hasEndMarker =
    expectedMime === 'image/jpeg'
      ? file.buffer.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
      : file.buffer.length >= PNG_IEND.length &&
        file.buffer.subarray(-PNG_IEND.length).equals(PNG_IEND);
  if (!hasEndMarker)
    throw new BadRequestException(
      'Receipt must be a valid, complete JPG, JPEG, or PNG image.',
    );

  try {
    const image = sharp(file.buffer, {
      animated: true,
      failOn: 'warning',
      limitInputPixels: MAX_FUEL_RECEIPT_PIXELS,
    });
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    const pages = metadata.pages ?? 1;
    if (
      metadata.format !== (expectedMime === 'image/jpeg' ? 'jpeg' : 'png') ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(pages) ||
      width < 1 ||
      height < 1 ||
      pages < 1 ||
      width > MAX_FUEL_RECEIPT_SIDE_PX ||
      height > MAX_FUEL_RECEIPT_SIDE_PX ||
      width * height * pages > MAX_FUEL_RECEIPT_PIXELS
    ) {
      throw new BadRequestException(DIMENSION_LIMIT_MESSAGE);
    }

    await image.stats();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message))
      throw new BadRequestException(DIMENSION_LIMIT_MESSAGE);
    throw new BadRequestException(
      'Receipt must be a valid, complete JPG, JPEG, or PNG image.',
    );
  }

  return { extension, contentType: expectedMime };
}
