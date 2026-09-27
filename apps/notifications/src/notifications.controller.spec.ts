import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RmqContext } from '@nestjs/microservices';
import type { ConsumeMessage, MessageProperties, Options } from 'amqplib';
import {
  NOTIFICATIONS_DLQ_EXCHANGE,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_RETRY_QUEUE,
} from '@app/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotifyEmailDto } from './dto/notify-email.dto';

const VALID_PAYLOAD = { email: 'user@example.com', text: 'Payment received' };

type DeathEntry = { queue: string; reason: string; count: number };

function buildDeathHistory(count: number): DeathEntry[] {
  return [
    { queue: NOTIFICATIONS_RETRY_QUEUE, reason: 'expired', count },
    { queue: NOTIFICATIONS_QUEUE, reason: 'rejected', count },
  ];
}

function buildMessage(
  deathCount = 0,
  properties: Partial<MessageProperties> = {},
  deaths: DeathEntry[] = deathCount ? buildDeathHistory(deathCount) : [],
): ConsumeMessage {
  const headers = deaths.length ? { 'x-death': deaths } : {};

  return {
    content: Buffer.from(JSON.stringify({ pattern: 'notify_email' })),
    fields: { deliveryTag: 1 },
    properties: { headers, ...properties },
  } as unknown as ConsumeMessage;
}

// amqplib's Channel is an EventEmitter: publish() returns false when the
// write buffer is full and the channel emits 'drain' once it has space again.
function buildChannel() {
  return Object.assign(new EventEmitter(), {
    ack: jest.fn<void, [ConsumeMessage]>(),
    nack: jest.fn<void, [ConsumeMessage, boolean, boolean]>(),
    publish: jest
      .fn<boolean, [string, string, Buffer, Options.Publish]>()
      .mockReturnValue(true),
  });
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function buildContext(channel: object, message: ConsumeMessage): RmqContext {
  return {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
}

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notifyEmail: jest.Mock<Promise<void>, [NotifyEmailDto]>;
  let channel: ReturnType<typeof buildChannel>;
  let warnLog: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    notifyEmail = jest
      .fn<Promise<void>, [NotifyEmailDto]>()
      .mockResolvedValue(undefined);
    channel = buildChannel();

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: { notifyEmail } }],
    }).compile();

    controller = moduleRef.get(NotificationsController);
    warnLog = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  async function handle(payload: object, message = buildMessage()) {
    await controller.notifyEmail(payload, buildContext(channel, message));
    return message;
  }

  function getDlqPublishOptions(): Options.Publish {
    return channel.publish.mock.calls[0][3];
  }

  describe('successful delivery', () => {
    it('sends the email and acks the message', async () => {
      const message = await handle(VALID_PAYLOAD);

      expect(channel.ack).toHaveBeenCalledTimes(1);
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('passes the validated dto to the service', async () => {
      await handle(VALID_PAYLOAD);

      const [dto] = notifyEmail.mock.calls[0];
      expect(dto).toBeInstanceOf(NotifyEmailDto);
      expect(dto).toEqual(VALID_PAYLOAD);
    });
  });

  describe('retry', () => {
    beforeEach(() => notifyEmail.mockRejectedValue(new Error('SMTP down')));

    it('nacks without requeue on first failure so the message goes to the retry queue', async () => {
      const message = await handle(VALID_PAYLOAD);

      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('keeps retrying while attempts are below the limit', async () => {
      await handle(VALID_PAYLOAD, buildMessage(3));

      expect(channel.nack).toHaveBeenCalledTimes(1);
      expect(channel.publish).not.toHaveBeenCalled();
    });

    it('logs a warning with the attempt number and reason', async () => {
      await handle(VALID_PAYLOAD, buildMessage(2));

      expect(warnLog).toHaveBeenCalledWith(
        { attempt: 3, maxAttempts: 5, reason: 'SMTP down' },
        'retry scheduled',
      );
      expect(errorLog).not.toHaveBeenCalled();
    });
  });

  describe('dead letter queue', () => {
    beforeEach(() => notifyEmail.mockRejectedValue(new Error('SMTP down')));

    it('publishes to the DLQ exchange and acks on the last attempt', async () => {
      const message = await handle(VALID_PAYLOAD, buildMessage(4));

      expect(channel.publish).toHaveBeenCalledWith(
        NOTIFICATIONS_DLQ_EXCHANGE,
        '',
        message.content,
        expect.any(Object),
      );
      expect(channel.ack).toHaveBeenCalledWith(message);
      expect(channel.nack).not.toHaveBeenCalled();
    });

    it('publishes to the DLQ before acking so the message is never lost', async () => {
      await handle(VALID_PAYLOAD, buildMessage(4));

      const [publishOrder] = channel.publish.mock.invocationCallOrder;
      const [ackOrder] = channel.ack.mock.invocationCallOrder;
      expect(publishOrder).toBeLessThan(ackOrder);
    });

    it('sends to the DLQ when attempts exceed the limit', async () => {
      await handle(VALID_PAYLOAD, buildMessage(10));

      expect(channel.publish).toHaveBeenCalledTimes(1);
      expect(channel.nack).not.toHaveBeenCalled();
    });

    it('adds failure reason and attempts while keeping original properties', async () => {
      const message = buildMessage(4, {
        messageId: 'msg-1',
        contentType: 'application/json',
      });

      await handle(VALID_PAYLOAD, message);

      const options = getDlqPublishOptions();
      expect(options.messageId).toBe('msg-1');
      expect(options.contentType).toBe('application/json');
      expect(options.headers).toMatchObject({
        'x-death': message.properties.headers?.['x-death'],
        'x-failure-reason': 'SMTP down',
        'x-attempts': 5,
      });
    });

    it('truncates the failure reason to 500 characters', async () => {
      notifyEmail.mockRejectedValue(new Error('x'.repeat(1000)));

      await handle(VALID_PAYLOAD, buildMessage(4));

      expect(getDlqPublishOptions().headers).toMatchObject({
        'x-failure-reason': 'x'.repeat(500),
      });
    });

    // Each retry cycle adds a main-queue "rejected" and a retry-queue "expired"
    // entry; RabbitMQ keeps the most recent death first
    it.each<[string, DeathEntry[], number]>([
      [
        'retry-queue expiries ahead of the rejection',
        [
          { queue: NOTIFICATIONS_RETRY_QUEUE, reason: 'expired', count: 9 },
          { queue: NOTIFICATIONS_QUEUE, reason: 'rejected', count: 2 },
        ],
        3,
      ],
      [
        'a rejection from another queue',
        [
          { queue: 'some.other.queue', reason: 'rejected', count: 7 },
          { queue: NOTIFICATIONS_QUEUE, reason: 'rejected', count: 1 },
        ],
        2,
      ],
      [
        'only non-rejection deaths',
        [{ queue: NOTIFICATIONS_QUEUE, reason: 'expired', count: 3 }],
        1,
      ],
    ])(
      'counts only main-queue rejections with %s',
      async (_case, deaths, attempt) => {
        await handle({ email: 'not-an-email' }, buildMessage(0, {}, deaths));

        expect(getDlqPublishOptions().headers).toHaveProperty(
          'x-attempts',
          attempt,
        );
      },
    );

    it('counts attempts from the main queue rejection, not from index 0 of x-death', async () => {
      const message = buildMessage(0, {}, [
        { queue: 'some.other.queue', reason: 'expired', count: 1 },
        { queue: NOTIFICATIONS_QUEUE, reason: 'rejected', count: 4 },
      ]);

      await handle(VALID_PAYLOAD, message);

      expect(channel.publish).toHaveBeenCalledTimes(1);
      expect(getDlqPublishOptions().headers).toHaveProperty('x-attempts', 5);
    });

    it('logs an error with the attempt, reason and message id', async () => {
      await handle(VALID_PAYLOAD, buildMessage(4, { messageId: 'msg-1' }));

      expect(errorLog).toHaveBeenCalledWith(
        { attempt: 5, reason: 'SMTP down', messageId: 'msg-1' },
        'moved to DLQ',
      );
      expect(warnLog).not.toHaveBeenCalled();
    });
  });

  describe('full publish buffer', () => {
    const dlqCases = [
      ['last failed attempt', VALID_PAYLOAD, buildMessage(4)],
      [
        'invalid payload',
        { email: 'not-an-email', text: 'hi' },
        buildMessage(),
      ],
    ] as const;

    beforeEach(() => {
      notifyEmail.mockRejectedValue(new Error('SMTP down'));
      channel.publish.mockReturnValue(false);
    });

    it.each(dlqCases)(
      'waits for drain before acking (%s)',
      async (_case, payload, message) => {
        const handling = handle(payload, message);
        await flushAsync();

        expect(channel.publish).toHaveBeenCalledTimes(1);
        expect(channel.ack).not.toHaveBeenCalled();

        channel.emit('drain');
        await handling;

        expect(channel.ack).toHaveBeenCalledWith(message);
      },
    );

    it.each(dlqCases)(
      'resolves the handler only after the message is acked (%s)',
      async (_case, payload, message) => {
        let isSettled = false;
        const handling = handle(payload, message).then(() => {
          isSettled = true;
        });
        await flushAsync();

        expect(isSettled).toBe(false);

        channel.emit('drain');
        await handling;

        expect(channel.ack).toHaveBeenCalledTimes(1);
      },
    );

    it('nacks to the retry queue when the channel fails while waiting for drain', async () => {
      const channelError = new Error('channel closed');
      const message = buildMessage(4);
      const handling = handle(VALID_PAYLOAD, message);
      await flushAsync();

      channel.emit('error', channelError);
      await handling;

      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
      expect(errorLog).toHaveBeenCalledWith(
        { err: channelError },
        'failed to move message to DLQ',
      );
    });
  });

  describe('DLQ publish failure', () => {
    const publishError = new Error('Channel closed');

    beforeEach(() => {
      notifyEmail.mockRejectedValue(new Error('SMTP down'));
      channel.publish.mockImplementation(() => {
        throw publishError;
      });
    });

    it('nacks without requeue so the message retries the DLQ after the delay', async () => {
      const message = await handle(VALID_PAYLOAD, buildMessage(4));

      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.nack).toHaveBeenCalledWith(message, false, false);
      expect(errorLog).toHaveBeenCalledWith(
        { err: publishError },
        'failed to move message to DLQ',
      );
    });

    it('does not throw when the channel is already dead', async () => {
      const nackError = new Error('Channel closed');
      channel.nack.mockImplementation(() => {
        throw nackError;
      });

      await expect(
        handle(VALID_PAYLOAD, buildMessage(4)),
      ).resolves.toBeDefined();
      expect(errorLog).toHaveBeenCalledWith(
        { err: nackError },
        'failed to nack message',
      );
    });
  });

  describe('invalid payload', () => {
    it.each([
      ['invalid email', { email: 'not-an-email', text: 'hi' }],
      ['missing text', { email: 'user@example.com' }],
    ])(
      'sends %s straight to the DLQ without retrying',
      async (_case, payload) => {
        const message = await handle(payload);

        expect(notifyEmail).not.toHaveBeenCalled();
        expect(channel.nack).not.toHaveBeenCalled();
        expect(channel.publish).toHaveBeenCalledWith(
          NOTIFICATIONS_DLQ_EXCHANGE,
          '',
          message.content,
          expect.any(Object),
        );
        expect(getDlqPublishOptions().headers).toHaveProperty('x-attempts', 1);
        expect(channel.ack).toHaveBeenCalledWith(message);
      },
    );

    it.each([
      ['null', null],
      ['a string', 'not json'],
      ['missing data', undefined],
    ])(
      'sends a payload that is %s to the DLQ and acks it instead of throwing',
      async (_case, payload) => {
        const message = buildMessage();

        await controller.notifyEmail(payload, buildContext(channel, message));

        expect(notifyEmail).not.toHaveBeenCalled();
        expect(getDlqPublishOptions().headers).toHaveProperty(
          'x-failure-reason',
          'payload must be an object',
        );
        expect(channel.ack).toHaveBeenCalledWith(message);
      },
    );

    it('stores validation errors as the failure reason', async () => {
      await handle({ email: 'not-an-email', text: 'hi' });

      expect(getDlqPublishOptions().headers).toHaveProperty(
        'x-failure-reason',
        'email must be an email',
      );
    });
  });
});
