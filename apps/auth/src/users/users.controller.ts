import { Controller, Post, Body, UseGuards, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../decorators/current-user.decorator';
import { UserDocument } from './entities/user.entity';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  async create(@Body() createUserDto: CreateUserDto) {
    const { password, ...userResponse } =
      await this.usersService.create(createUserDto);

    return userResponse;
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getCurrentUser(@CurrentUser() user: UserDocument) {
    const { password, ...userResponse } = user;

    return userResponse;
  }
}
