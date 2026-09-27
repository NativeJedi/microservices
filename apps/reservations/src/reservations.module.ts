import { Module } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import {
  AUTH_SERVICE,
  commonEnvValidationRules,
  DatabaseModule,
  LoggerModule,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_QUEUE_OPTIONS,
  NOTIFICATIONS_SERVICE,
  PAYMENTS_SERVICE,
} from '@app/common';
import { ReservationsRepository } from './reservations.repository';
import {
  ReservationDocument,
  ReservationSchema,
} from './entities/reservation.entity';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentsGateway } from './payments.gateway';
import { OutboxRelay } from './outbox/outbox.relay';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        MONGODB_URI: commonEnvValidationRules.MONGODB_URI,
        RABBITMQ_URI: z.string(),
        PORT: commonEnvValidationRules.PORT,
        AUTH_HOST: z.string(),
        AUTH_PORT: commonEnvValidationRules.PORT,
        PAYMENTS_HOST: z.string(),
        PAYMENTS_PORT: commonEnvValidationRules.PORT,
      }),
    }),
    ScheduleModule.forRoot(),
    LoggerModule,
    DatabaseModule,
    DatabaseModule.forFeature([
      { name: ReservationDocument.name, schema: ReservationSchema },
    ]),
    ClientsModule.registerAsync([
      {
        name: AUTH_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get('AUTH_HOST'),
            port: configService.get('AUTH_PORT'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: PAYMENTS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get('PAYMENTS_HOST'),
            port: configService.get('PAYMENTS_PORT'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: NOTIFICATIONS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.getOrThrow<string>('RABBITMQ_URI')],
            queue: NOTIFICATIONS_QUEUE,
            queueOptions: NOTIFICATIONS_QUEUE_OPTIONS,
            // The relay marks an event published once the broker confirms it,
            // so it must survive a broker restart
            persistent: true,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    ReservationsRepository,
    PaymentsGateway,
    OutboxRelay,
    ReconciliationService,
  ],
})
export class ReservationsModule {}
