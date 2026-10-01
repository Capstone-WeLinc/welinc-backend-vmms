import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';

const allowedNames = ['Alex Cruz', 'M-12', 'Fleet 2 - West'];
const rejectedNames = ['Alex_Cruz', 'Alex.Cruz', "Alex O'Neil", 'Alex@WeLinc'];
const expectedMessage = 'Name must contain alphanumeric characters only.';

describe('user account name validation', () => {
  it.each(allowedNames)('allows %s on account creation', async (name) => {
    const errors = await validate(plainToInstance(CreateUserDto, { name }));
    expect(errors.find((error) => error.property === 'name')).toBeUndefined();
  });

  it.each(rejectedNames)('rejects %s on account creation with the required message', async (name) => {
    const errors = await validate(plainToInstance(CreateUserDto, { name }));
    expect(errors.find((error) => error.property === 'name')?.constraints).toMatchObject({
      matches: expectedMessage,
    });
  });

  it.each(allowedNames)('allows %s on account edits', async (name) => {
    const errors = await validate(plainToInstance(UpdateUserDto, { name }));
    expect(errors.find((error) => error.property === 'name')).toBeUndefined();
  });

  it.each(rejectedNames)('rejects %s on account edits with the required message', async (name) => {
    const errors = await validate(plainToInstance(UpdateUserDto, { name }));
    expect(errors.find((error) => error.property === 'name')?.constraints).toMatchObject({
      matches: expectedMessage,
    });
  });
});
