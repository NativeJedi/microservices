import { Module } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import {
  commonEnvValidationRules,
  DatabaseModule,
  LoggerModule,
} from '@app/common';
import { ReservationsRepository } from './reservations.repository';
import {
  ReservationDocument,
  ReservationSchema,
} from './entities/reservation.entity';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: z.object({
        MONGODB_URI: commonEnvValidationRules.MONGODB_URI,
        PORT: commonEnvValidationRules.PORT,
      }),
    }),
    LoggerModule,
    DatabaseModule,
    DatabaseModule.forFeature([
      { name: ReservationDocument.name, schema: ReservationSchema },
    ]),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationsRepository],
})
export class ReservationsModule {}
