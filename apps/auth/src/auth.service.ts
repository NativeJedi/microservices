import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserDocument } from './users/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  login(user: UserDocument) {
    const payload = { userId: user._id.toHexString() };
    // ConfigService returns the raw env string, so coerce before arithmetic
    const expiresInSeconds = Number(
      this.configService.getOrThrow('JWT_EXPIRATION'),
    );

    const expires = new Date();
    expires.setSeconds(expires.getSeconds() + expiresInSeconds);

    return {
      token: this.jwtService.sign(payload),
      expires,
    };
  }
}
