import { Injectable, Logger } from '@nestjs/common';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { ReservationsRepository } from './reservations.repository';
import { ReservationDocument } from './entities/reservation.entity';
import { reservationConfirmedEvent } from './outbox/utils';
import { toChargeFailure } from './utils';
import { PaymentsGateway } from './payments.gateway';

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60_000;
const LOCK_TTL_MS = 60_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;
const RECONCILE_INTERVAL = 'reservation-reconciliation';

// This service is responsible for catching of pending reservations
// that stuck in pending state because of process failure
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly repository: ReservationsRepository,
    private readonly payments: PaymentsGateway,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  @Interval(RECONCILE_INTERVAL, RECONCILE_INTERVAL_MS)
  async reconcile(): Promise<void> {
    if (this.running) return;

    this.running = true;

    try {
      for (let i = 0; i < BATCH_SIZE; i++) {
        // protection against multiple instances of the same process
        const reservation = await this.claim();

        if (!reservation) return;

        try {
          await this.finish(reservation);
        } catch (err) {
          if (err instanceof TypeError || err instanceof ReferenceError) {
            this.stop(err);
            return;
          }
          this.logger.error({ err }, 'reconciliation failed');
        } finally {
          await this.repository.findOneAndUpdateOrNull(
            { _id: reservation._id },
            { $set: { lockedUntil: null } },
          );
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'reconciliation failed');
    } finally {
      this.running = false;
    }
  }

  private claim(): Promise<ReservationDocument | null> {
    const now = new Date();

    return this.repository.findOneAndUpdateOrNull(
      {
        status: 'pending',
        timestamp: { $lt: new Date(now.getTime() - STALE_AFTER_MS) },
        reconcileAttempts: { $lt: MAX_ATTEMPTS },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      {
        $set: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) },
        $inc: { reconcileAttempts: 1 }, // attempts counter
      },
    );
  }

  private async finish(reservation: ReservationDocument): Promise<void> {
    try {
      // Double transaction can't be performed because of idempotency key
      const invoiceId = await this.payments.charge(reservation);

      const confirmed = await this.repository.findOneAndUpdateOrNull(
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

      if (confirmed) {
        this.logger.warn(
          {
            reservationId: reservation._id,
            attempt: reservation.reconcileAttempts,
          },
          'reservation recovered by reconciliation',
        );
      }
    } catch (failure) {
      await this.handleFailure(reservation, failure);
    }
  }

  private async handleFailure(
    reservation: ReservationDocument,
    failure: unknown,
  ): Promise<void> {
    const { kind, message } = toChargeFailure(failure);

    // it is user card problem - reservation goes to fail status
    if (kind === 'declined' || kind === 'rejected') {
      await this.repository.findOneAndUpdateOrNull(
        { _id: reservation._id, status: 'pending' },
        { $set: { status: 'failed', failureReason: message } },
      );
      return;
    }

    // Attempt limit reached - reservation goes to needs_review status
    if (reservation.reconcileAttempts >= MAX_ATTEMPTS) {
      await this.repository.findOneAndUpdateOrNull(
        { _id: reservation._id, status: 'pending' },
        { $set: { status: 'needs_review', failureReason: message } },
      );

      this.logger.error(
        { reservationId: reservation._id, reason: message },
        'reconciliation gave up, manual review required',
      );
    }

    // Do nothing reconciliation process will take one more iteration
  }

  private stop(err: unknown): void {
    this.scheduler.deleteInterval(RECONCILE_INTERVAL);
    this.logger.fatal(
      { err },
      'reconciliation stopped — pending reservations will NOT be recovered until restart',
    );
  }
}
