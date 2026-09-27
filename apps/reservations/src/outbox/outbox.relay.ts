// apps/reservations/src/outbox.relay.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval, SchedulerRegistry } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { NOTIFICATIONS_SERVICE } from '@app/common';
import { ReservationsRepository } from '../reservations.repository';
import { ReservationDocument } from '../entities/reservation.entity';

const RELAY_INTERVAL_MS = 1_000;
const LOCK_TTL_MS = 30_000; // time of locking document
const BATCH_SIZE = 50; // count of documents to publish at one iteration
const RELAY_INTERVAL = 'outbox-relay';

// This service is responsible for publishing events from the outbox
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;

  constructor(
    private readonly repository: ReservationsRepository,
    @Inject(NOTIFICATIONS_SERVICE) private readonly notifications: ClientProxy,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  @Interval(RELAY_INTERVAL, RELAY_INTERVAL_MS)
  async publishPending(): Promise<void> {
    if (this.running) return;

    this.running = true;

    try {
      for (let i = 0; i < BATCH_SIZE; i++) {
        // protection against multiple instances of the same process
        const document = await this.claim();

        if (!document) return;

        try {
          await this.publishEvents(document);
        } catch (err) {
          if (err instanceof TypeError || err instanceof ReferenceError) {
            this.stop(err);
            return;
          }

          this.logger.error({ err }, 'outbox relay failed');
        } finally {
          await this.release(document); // release lock even if publish failed
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'outbox relay failed');
    } finally {
      this.running = false;
    }
  }

  private claim(): Promise<ReservationDocument | null> {
    const now = new Date();

    return this.repository.findOneAndUpdateOrNull(
      {
        outbox: {
          $elemMatch: { publishedAt: null },
        },
        $or: [
          { lockedUntil: null }, // if noone writes document
          { lockedUntil: { $lt: now } }, // or lock is expired
        ],
      },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) } },
    );
  }

  private release(document: ReservationDocument): Promise<unknown> {
    return this.repository.findOneAndUpdateOrNull(
      { _id: document._id },
      { $set: { lockedUntil: null } },
    );
  }

  private async publishEvents(document: ReservationDocument): Promise<void> {
    // Publish first, mark second — on purpose.
    // If the process dies in between, the event is published again on the next
    // run, so consumers must tolerate duplicates (at-least-once delivery).
    // The reverse order would risk losing the event entirely, which is worse.
    //
    // We knowingly accept duplicate confirmation emails here: a second email is
    // a minor annoyance, and deduplication would require a shared store
    // (Redis / processed-events table) that is not worth it for notifications.
    // Any future consumer with side effects on money or stock levels MUST
    // deduplicate by `eventId` before acting.
    for (const event of document.outbox.filter((e) => !e.publishedAt)) {
      await lastValueFrom(
        this.notifications.emit(event.pattern, {
          ...event.payload,
          eventId: event.eventId,
        }),
      );

      await this.repository.findOneAndUpdateOrNull(
        { _id: document._id, 'outbox.eventId': event.eventId },
        { $set: { 'outbox.$.publishedAt': new Date() } },
      );
    }
  }

  private stop(err: unknown): void {
    this.scheduler.deleteInterval(RELAY_INTERVAL); // таймер видалено, більше не тикає
    this.logger.fatal(
      { err },
      'outbox relay stopped — events will NOT be published until restart',
    );
  }
}
