import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { z } from 'zod';
import { commonEnvValidationRules, LoggerModule } from '@app/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from './users/users.module';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        NODE_ENV: z.string().default('development'),
        MONGODB_URI: commonEnvValidationRules.MONGODB_URI,
        PORT: commonEnvValidationRules.PORT,
        TCP_PORT: commonEnvValidationRules.PORT,
        JWT_SECRET: z.string(),
        JWT_EXPIRATION: z.coerce.number().positive(),
      }),
    }),
    UsersModule,
    LoggerModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: `${configService.getOrThrow<number>('JWT_EXPIRATION')}s`,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy],
})
export class AuthModule {}
