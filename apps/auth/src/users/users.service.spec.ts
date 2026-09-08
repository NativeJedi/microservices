import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';

// @nestjs/mongoose is ESM-only and cannot be required by the CommonJS jest
// runtime, so the repository is replaced before its module is ever loaded.
jest.mock('./users.repository', () => ({
  UsersRepository: class UsersRepository {},
}));

const buildDuplicateKeyError = () =>
  Object.assign(
    new Error('E11000 duplicate key error collection: sleepr.userdocuments'),
    { code: 11000 },
  );

describe('UsersService', () => {
  let service: UsersService;
  let usersRepository: { create: jest.Mock };

  beforeEach(async () => {
    usersRepository = { create: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: usersRepository },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('create', () => {
    it('rejects an email that is already registered', async () => {
      usersRepository.create.mockRejectedValue(buildDuplicateKeyError());

      await expect(
        service.create({ email: 'taken@email.com', password: 'Str0ng!Pass1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows errors that are not duplicate-key violations', async () => {
      usersRepository.create.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.create({ email: 'new@email.com', password: 'Str0ng!Pass1' }),
      ).rejects.toThrow('connection lost');
    });
  });
});
