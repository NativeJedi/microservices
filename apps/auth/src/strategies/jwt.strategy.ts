import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { UsersService } from '../users/users.service';

export interface TokenPayload {
  userId: string;
}

const extractJwtFromCookie = (request: Request): string | null => {
  const cookies = request.cookies as Record<string, string | undefined>;

  return cookies?.Authentication ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractJwtFromCookie]),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate({ userId }: TokenPayload) {
    return this.usersService.getUserById(userId);
  }
}
