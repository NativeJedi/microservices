import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { ReservationsRepository } from './reservations.repository';
import { isDuplicateKeyError, UserDto } from '@app/common';
import { ReservationDocument } from './entities/reservation.entity';
import { toChargeFailure } from './utils';
import { buildClientKey, reservationConfirmedEvent } from './outbox/utils';
import { PaymentsGateway } from './payments.gateway';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly payments: PaymentsGateway,
    private readonly reservationsRepository: ReservationsRepository,
  ) {}

  async create(
    dto: CreateReservationDto,
    user: UserDto,
    idempotencyKey: string,
  ): Promise<ReservationDocument> {
    const clientKey = buildClientKey(user._id, idempotencyKey);

    // Check if reservation is created
    const existing = await this.reservationsRepository.findOneOrNull({
      clientKey,
    });

    if (existing) return this.checkExistingReservation(existing);

    // 1. Creating of reservation in pending status
    const reservation = await this.insertPending(dto, user, clientKey);

    // A parallel request with the same key won the insert: never charge twice
    if (!reservation) {
      const created = await this.reservationsRepository.findOne({ clientKey });
      return this.checkExistingReservation(created);
    }

    // 2. charging
    const invoiceId = await this.chargeOrFail(reservation);

    // 3. Confirmation of payment
    return this.confirm(reservation, invoiceId);
  }

  /** Returns null when a reservation with the same clientKey already exists. */
  private async insertPending(
    dto: CreateReservationDto,
    { email, _id: userId }: UserDto,
    clientKey: string,
  ): Promise<ReservationDocument | null> {
    return this.reservationsRepository
      .create({
        startDate: dto.startDate,
        endDate: dto.endDate,
        timestamp: new Date(),
        userId,
        clientKey,
        email,
        amount: dto.charge.amount,
        paymentMethodId: dto.charge.paymentMethodId,
        status: 'pending',
        invoiceId: null,
        failureReason: null,
        reconcileAttempts: 0,
        lockedUntil: null,
        outbox: [],
      })
      .catch((err: unknown) => {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      });
  }

  private async confirm(
    reservation: ReservationDocument,
    invoiceId: string,
  ): Promise<ReservationDocument> {
    const confirmed = await this.reservationsRepository.findOneAndUpdateOrNull(
      { _id: reservation._id, status: 'pending' },
      {
        $set: { status: 'confirmed', invoiceId },
        $push: {
          outbox: reservationConfirmedEvent(
            reservation._id,
            reservation.email,
            reservation.amount,
          ),
        },
      },
    );

    // If someone already confirmed transaction (reconciliation, webhook, etc)
    return (
      confirmed ?? this.reservationsRepository.findOne({ _id: reservation._id })
    );
  }

  private checkExistingReservation(
    reservation: ReservationDocument,
  ): ReservationDocument {
    // If it is pending - then it's a race
    if (reservation.status === 'pending') {
      throw new ConflictException('Reservation is being processed'); // 409
    }

    if (reservation.status === 'needs_review') {
      throw new ConflictException('Reservation requires manual review');
    }

    if (reservation.status === 'failed') {
      throw new BadRequestException(
        reservation.failureReason ?? 'Payment failed',
      );
    }
    return reservation;
  }

  private async chargeOrFail(
    reservation: ReservationDocument,
  ): Promise<string> {
    try {
      return await this.payments.charge(reservation);
    } catch (error) {
      const failure = toChargeFailure(error);

      // Result is unknown. Reservation should keep pending status. We will check it later
      if (failure.kind === 'unknown') {
        this.logger.error(
          { reservationId: reservation._id, reason: failure.message },
          'charge result unknown, left pending for reconciliation',
        );
        throw new ServiceUnavailableException(
          'Payment is being processed, we will confirm shortly',
        );
      }

      await this.reservationsRepository.findOneAndUpdateOrNull(
        { _id: reservation._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: failure.message } },
      );

      throw new BadRequestException(failure.message);
    }
  }

  async findAll() {
    return this.reservationsRepository.find({});
  }

  async findOne(id: string) {
    return this.reservationsRepository.findOne({ _id: id });
  }

  async update(id: string, updateReservationDto: UpdateReservationDto) {
    return this.reservationsRepository.findOneAndUpdate(
      { _id: id },
      { $set: updateReservationDto },
    );
  }

  // A pending or needs_review reservation may have money in flight:
  // deleting it would leave a charge without a record
  async remove(id: string) {
    return this.reservationsRepository.findOneAndDelete({
      _id: id,
      status: { $nin: ['pending', 'needs_review'] },
    });
  }
}
