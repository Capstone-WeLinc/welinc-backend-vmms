import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationsInboxQueryDto } from './notifications-inbox.dto';

describe('NotificationsInboxQueryDto', () => {
  it('rejects invalid limits, categories, and read states', async () => {
    const query = plainToInstance(NotificationsInboxQueryDto, {
      limit: '101',
      category: 'UNKNOWN',
      readState: 'SOMETHING',
    });

    const errors = await validate(query);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['limit', 'category', 'readState']),
    );
  });

  it('defaults the limit and read-state filter', async () => {
    const query = plainToInstance(NotificationsInboxQueryDto, {});

    expect(await validate(query)).toHaveLength(0);
    expect(query.limit).toBe(30);
    expect(query.readState).toBe('ALL');
  });
});
