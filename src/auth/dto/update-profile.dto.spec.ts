import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

describe('profile mobile number', () => {
  it.each(['09171234567', '639171234567', '+639171234567', '+63 (917) 123-4567'])('normalizes %s', async (contact) => {
    const dto = plainToInstance(UpdateProfileDto, { contact });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.contact).toBe('+639171234567');
  });
  it.each(['+12025550123', '+6309171234567', '0917123456', '091712345678', 'hello', 9171234567])('rejects %s', async (contact) => {
    expect((await validate(plainToInstance(UpdateProfileDto, { contact }))).length).toBeGreaterThan(0);
  });
  it.each([null, undefined, '', '  '])('allows an optional empty phone number %s', async (contact) => {
    expect(await validate(plainToInstance(UpdateProfileDto, { contact }))).toHaveLength(0);
  });
});
