import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVehicleDto } from './create-vehicle.dto';

describe('CreateVehicleDto', () => {
  const validInput = {
    plateNumber: 'ABC 1234',
    make: 'Isuzu',
    model: 'Elf',
    year: '2022',
    engineType: 'Diesel',
    truckSizeCategory: 'Light Duty',
    odometer: '100',
    garageId: '550e8400-e29b-41d4-a716-446655440000',
  };

  it('accepts all required vehicle registration fields', async () => {
    const dto = plainToInstance(CreateVehicleDto, validInput);

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.year).toBe(2022);
    expect(dto.odometer).toBe(100);
  });

  it('rejects missing required registration fields', async () => {
    const dto = plainToInstance(CreateVehicleDto, {
      ...validInput,
      make: '',
      garageId: '',
    });

    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(['make', 'garageId']));
  });

  it('rejects fractional years and negative odometer baselines', async () => {
    const dto = plainToInstance(CreateVehicleDto, {
      ...validInput,
      year: '2022.5',
      odometer: '-1',
    });

    const errors = await validate(dto);
    const properties = errors.map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(['year', 'odometer']));
  });
});
