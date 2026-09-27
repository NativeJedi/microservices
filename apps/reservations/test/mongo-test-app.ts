import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Model, Types } from 'mongoose';
import { of } from 'rxjs';
import { NOTIFICATIONS_SERVICE } from '@app/common';
import {
  OutboxEventDocument,
  ReservationDocument,
  ReservationSchema,
} from '../src/entities/reservation.entity';
import { ReservationsRepository } from '../src/reservations.repository';
import { ReservationsService } from '../src/reservations.service';
import { ReconciliationService } from '../src/reconciliation.service';
import { PaymentsGateway } from '../src/payments.gateway';
import { OutboxRelay } from '../src/outbox/outbox.relay';

export const MONGO_STARTUP_TIMEOUT_MS = 120_000;

const MINUTE_MS = 60_000;

export const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * MINUTE_MS);

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real Mongo (in memory) with the real repository and services.
 * Only the process boundaries are mocked: payments (TCP), RabbitMQ and the scheduler.
 * Background jobs are driven by calling reconcile()/publishPending() directly.
 */
export class MongoTestApp {
  readonly charge = jest.fn<Promise<string>, [ReservationDocument]>();
  readonly emit = jest.fn();
  readonly deleteInterval = jest.fn();

  private mongo: MongoMemoryServer;
  private moduleRef: TestingModule;

  async start(): Promise<void> {
    // The first launch can be slow (binary download, Rosetta on Apple silicon)
    this.mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: MONGO_STARTUP_TIMEOUT_MS },
    });
    this.moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(this.mongo.getUri()),
        MongooseModule.forFeature([
          { name: ReservationDocument.name, schema: ReservationSchema },
        ]),
      ],
      providers: [
        ReservationsRepository,
        ReservationsService,
        ReconciliationService,
        OutboxRelay,
        { provide: PaymentsGateway, useValue: { charge: this.charge } },
        { provide: NOTIFICATIONS_SERVICE, useValue: { emit: this.emit } },
        {
          provide: SchedulerRegistry,
          useValue: { deleteInterval: this.deleteInterval },
        },
      ],
    }).compile();
    Logger.overrideLogger(false); // compile() installs its own logger

    // The unique clientKey index must exist before concurrency tests
    await this.model.init();
  }

  async stop(): Promise<void> {
    await this.moduleRef?.close();
    await this.mongo?.stop();
  }

  async reset(): Promise<void> {
    jest.resetAllMocks();
    this.charge.mockResolvedValue('pi_default');
    this.emit.mockReturnValue(of(undefined));
    await this.model.deleteMany({});
  }

  get model(): Model<ReservationDocument> {
    return this.moduleRef.get(getModelToken(ReservationDocument.name));
  }

  get repository(): ReservationsRepository {
    return this.moduleRef.get(ReservationsRepository);
  }

  get service(): ReservationsService {
    return this.moduleRef.get(ReservationsService);
  }

  get reconciliation(): ReconciliationService {
    return this.moduleRef.get(ReconciliationService);
  }

  get relay(): OutboxRelay {
    return this.moduleRef.get(OutboxRelay);
  }

  /** A second process: same database, its own in-memory `running` flag. */
  newReconciliationInstance(): ReconciliationService {
    return new ReconciliationService(
      this.moduleRef.get(ReservationsRepository),
      { charge: this.charge } as unknown as PaymentsGateway,
      { deleteInterval: this.deleteInterval } as unknown as SchedulerRegistry,
    );
  }

  /** A second process: same database, its own in-memory `running` flag. */
  newRelayInstance(): OutboxRelay {
    return new OutboxRelay(
      this.moduleRef.get(ReservationsRepository),
      { emit: this.emit } as never,
      { deleteInterval: this.deleteInterval } as unknown as SchedulerRegistry,
    );
  }

  /** Stale pending reservation, as left by a process that died mid-flow. */
  async seed(
    overrides: Partial<ReservationDocument> = {},
  ): Promise<ReservationDocument> {
    const created = await this.model.create({
      _id: new Types.ObjectId(),
      timestamp: minutesAgo(3),
      startDate: new Date('2026-10-01'),
      endDate: new Date('2026-10-05'),
      userId: 'user-1',
      clientKey: new Types.ObjectId().toHexString(),
      email: 'user@example.com',
      amount: 10,
      paymentMethodId: 'pm_card_visa',
      status: 'pending',
      invoiceId: null,
      failureReason: null,
      reconcileAttempts: 0,
      lockedUntil: null,
      outbox: [],
      ...overrides,
    });
    return created.toObject();
  }

  /** Bypasses the schema, e.g. to create documents written by older code. */
  async seedRaw(document: Record<string, unknown>): Promise<Types.ObjectId> {
    const _id = new Types.ObjectId();
    await this.model.collection.insertOne({ _id, ...document });
    return _id;
  }

  async read(id: Types.ObjectId): Promise<ReservationDocument> {
    const document = await this.model.findById(id).lean<ReservationDocument>();
    if (!document) throw new Error(`reservation ${id.toHexString()} not found`);
    return document;
  }

  /** Simulates the passage of time until every lock has expired. */
  async expireLocks(): Promise<void> {
    await this.model.updateMany(
      { lockedUntil: { $ne: null } },
      { $set: { lockedUntil: minutesAgo(1) } },
    );
  }
}

export function buildEvent(
  name: string,
  publishedAt: Date | null = null,
): OutboxEventDocument {
  return {
    eventId: `event-${name}`,
    pattern: 'notify_email',
    payload: { email: 'user@example.com', text: `text ${name}` },
    publishedAt,
  };
}
