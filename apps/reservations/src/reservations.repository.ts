import { Injectable, Logger } from '@nestjs/common';
import { AbstractRepository } from '@app/common';
import { ReservationDocument } from './entities/reservation.entity';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Injectable()
export class ReservationsRepository extends AbstractRepository<ReservationDocument> {
  protected readonly logger = new Logger(ReservationsRepository.name);

  constructor(
    @InjectModel(ReservationDocument.name)
    reservationsModel: Model<ReservationDocument>,
  ) {
    super(reservationsModel);
  }
}
