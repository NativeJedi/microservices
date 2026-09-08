import { Controller, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UserDocument } from './users/entities/user.entity';
import { CurrentUser } from './decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @UseGuards(AuthGuard('local'))
  @Post('login')
  login(
    @CurrentUser() user: UserDocument,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, expires } = this.authService.login(user);
    const isProduction = this.configService.get('NODE_ENV') === 'production';

    response.cookie('Authentication', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      expires,
    });

    const { password, ...userResponse } = user;

    return userResponse;
  }
}
