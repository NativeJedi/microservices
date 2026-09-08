import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersRepository } from './users.repository';

const DUPLICATE_KEY_ERROR_CODE = 11000;

const isDuplicateKeyError = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  error.code === DUPLICATE_KEY_ERROR_CODE;

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async create(createUserDto: CreateUserDto) {
    try {
      return await this.usersRepository.create({
        ...createUserDto,
        password: await bcrypt.hash(createUserDto.password, 10),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException('Email already registered');
      }

      throw error;
    }
  }

  async verifyUser(email: string, password: string) {
    const user = await this.findUserByEmail(email);

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }

  async getUserById(userId: string) {
    return this.usersRepository.findOne({ _id: userId });
  }

  private async findUserByEmail(email: string) {
    try {
      return await this.usersRepository.findOne({ email });
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }
  }
}
