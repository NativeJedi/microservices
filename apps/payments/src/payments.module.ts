import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  commonEnvValidationRules,
  LoggerModule,
  NOTIFICATIONS_SERVICE,
} from '@app/common';
import z from 'zod';
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        PORT: commonEnvValidationRules.PORT,
        NOTIFICATIONS_HOST: z.string(),
        NOTIFICATIONS_PORT: commonEnvValidationRules.PORT,
        STRIPE_SECRET_KEY: z.string(),
      }),
    }),
    LoggerModule,
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.getOrThrow('NOTIFICATIONS_HOST'),
            port: configService.getOrThrow('NOTIFICATIONS_PORT'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
