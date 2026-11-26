import sharp from 'sharp';
import {
  type FuelReceiptFile,
  validateFuelReceiptFile,
} from './fuel-receipt-file';

async function createReceipt(
  format: 'jpeg' | 'png',
  width = 16,
  height = 16,
): Promise<FuelReceiptFile> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 120, b: 160 },
    },
  })
    .toFormat(format)
    .toBuffer();
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  return {
    originalname: `receipt.${extension}`,
    mimetype: `image/${format}`,
    buffer,
  };
}

describe('validateFuelReceiptFile', () => {
  it.each(['jpeg', 'png'] as const)(
    'fully decodes a valid %s and preserves its original bytes',
    async (format) => {
      const file = await createReceipt(format);
      const originalBytes = Buffer.from(file.buffer);

      await expect(validateFuelReceiptFile(file)).resolves.toEqual({
        extension: format === 'jpeg' ? '.jpg' : '.png',
        contentType: `image/${format}`,
      });
      expect(file.buffer).toEqual(originalBytes);
    },
  );

  it('rejects truncated images and corrupt image payloads', async () => {
    const png = await createReceipt('png');
    const truncated = {
      ...png,
      buffer: png.buffer.subarray(0, Math.floor(png.buffer.length / 2)),
    };
    const corruptJpeg: FuelReceiptFile = {
      originalname: 'receipt.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]),
    };

    await expect(validateFuelReceiptFile(truncated)).rejects.toThrow(
      'complete JPG, JPEG, or PNG',
    );
    await expect(validateFuelReceiptFile(corruptJpeg)).rejects.toThrow(
      'complete JPG, JPEG, or PNG',
    );
  });

  it.each([
    [8_001, 1],
    [5_000, 5_000],
  ])(
    'rejects dimensions %i x %i and leaves the submitted bytes unchanged',
    async (width, height) => {
      const file = await createReceipt('png', width, height);
      const originalBytes = Buffer.from(file.buffer);

      await expect(validateFuelReceiptFile(file)).rejects.toThrow(
        '20 megapixels total',
      );
      expect(file.buffer).toEqual(originalBytes);
    },
  );
});
