import { Module } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import {
  AUTH_SERVICE,
  commonEnvValidationRules,
  DatabaseModule,
  LoggerModule,
} from '@app/common';
import { ReservationsRepository } from './reservations.repository';
import {
  ReservationDocument,
  ReservationSchema,
} from './entities/reservation.entity';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        MONGODB_URI: commonEnvValidationRules.MONGODB_URI,
        PORT: commonEnvValidationRules.PORT,
        AUTH_HOST: z.string(),
        AUTH_PORT: commonEnvValidationRules.PORT,
      }),
    }),
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
    ]),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationsRepository],
})
export class ReservationsModule {}
