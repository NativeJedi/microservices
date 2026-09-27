import { Injectable, Logger } from '@nestjs/common';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { ReservationsRepository } from './reservations.repository';
import {
  ReservationDocument,
  ReservationStatus,
} from './entities/reservation.entity';
import { reservationConfirmedEvent } from './outbox/utils';
import { toChargeFailure } from './utils';
import { PaymentsGateway } from './payments.gateway';

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60_000;
const LOCK_TTL_MS = 60_000;
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;
const RECONCILE_INTERVAL = 'reservation-reconciliation';
// Stripe keeps idempotency keys for at least 24h. A retry after that is a new
// charge, so older reservations are handed to a human instead.
const MAX_CHARGE_AGE_MS = 23 * 60 * 60_000;

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

        // A failed reservation keeps its lock on purpose: the lock expiry is
        // the retry backoff, otherwise this loop would re-claim it right away
        try {
          await this.process(reservation);
        } catch (err) {
          if (err instanceof TypeError || err instanceof ReferenceError) {
            this.stop(err);
            return;
          }
          this.logger.error({ err }, 'reconciliation failed');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'reconciliation failed');
    } finally {
      this.running = false;
    }
  }

  // No attempts filter here: a reservation that crashed on its last attempt
  // must still be claimed once more to be moved to needs_review
  private claim(): Promise<ReservationDocument | null> {
    const now = new Date();

    return this.repository.findOneAndUpdateOrNull(
      {
        status: 'pending',
        timestamp: { $lt: new Date(now.getTime() - STALE_AFTER_MS) },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      {
        $set: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) },
        $inc: { reconcileAttempts: 1 }, // attempts counter
      },
    );
  }

  private async process(reservation: ReservationDocument): Promise<void> {
    const giveUpReason = this.getGiveUpReason(reservation);
    if (giveUpReason) return this.giveUp(reservation, giveUpReason);

    let invoiceId: string;
    try {
      // Double transaction can't be performed because of idempotency key
      invoiceId = await this.payments.charge(reservation);
    } catch (failure) {
      return this.handleFailure(reservation, failure);
    }

    // Outside the try on purpose: an error here is our bug or a database
    // outage, not a payment result, and must not trigger another charge
    await this.confirm(reservation, invoiceId);
  }

  private getGiveUpReason(reservation: ReservationDocument): string | null {
    if (reservation.reconcileAttempts > MAX_ATTEMPTS) {
      return 'reconciliation attempts exhausted';
    }

    const age = Date.now() - reservation.timestamp.getTime();
    if (age > MAX_CHARGE_AGE_MS) {
      return 'idempotency window expired, verify the charge in Stripe';
    }

    return null;
  }

  private async confirm(
    reservation: ReservationDocument,
    invoiceId: string,
  ): Promise<void> {
    const confirmed = await this.repository.findOneAndUpdateOrNull(
      { _id: reservation._id, status: 'pending' },
      {
        $set: { status: 'confirmed', invoiceId, lockedUntil: null },
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
  }

  private async handleFailure(
    reservation: ReservationDocument,
    failure: unknown,
  ): Promise<void> {
    const { kind, message } = toChargeFailure(failure);

    // it is user card problem - reservation goes to fail status
    if (kind === 'declined' || kind === 'rejected') {
      await this.settle(reservation, 'failed', message);
      return;
    }

    // Attempt limit reached - reservation goes to needs_review status
    if (reservation.reconcileAttempts >= MAX_ATTEMPTS) {
      await this.giveUp(reservation, message);
    }

    // Otherwise the lock expires and the next pass retries
  }

  private async giveUp(
    reservation: ReservationDocument,
    reason: string,
  ): Promise<void> {
    await this.settle(reservation, 'needs_review', reason);

    this.logger.error(
      { reservationId: reservation._id, reason },
      'reconciliation gave up, manual review required',
    );
  }

  private settle(
    reservation: ReservationDocument,
    status: ReservationStatus,
    failureReason: string,
  ): Promise<unknown> {
    return this.repository.findOneAndUpdateOrNull(
      { _id: reservation._id, status: 'pending' },
      { $set: { status, failureReason, lockedUntil: null } },
    );
  }

  private stop(err: unknown): void {
    this.scheduler.deleteInterval(RECONCILE_INTERVAL);
    this.logger.fatal(
      { err },
      'reconciliation stopped — pending reservations will NOT be recovered until restart',
    );
  }
}
