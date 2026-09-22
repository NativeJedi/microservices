import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  commonEnvValidationRules,
  LoggerModule,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_QUEUE_OPTIONS,
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
        RABBITMQ_URI: z.string(),
        STRIPE_SECRET_KEY: z.string(),
      }),
    }),
    LoggerModule,
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.getOrThrow<string>('RABBITMQ_URI')],
            queue: NOTIFICATIONS_QUEUE,
            queueOptions: NOTIFICATIONS_QUEUE_OPTIONS,
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
