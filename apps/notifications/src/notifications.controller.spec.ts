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

function buildChannel() {
  return {
    ack: jest.fn<void, [ConsumeMessage]>(),
    nack: jest.fn<void, [ConsumeMessage, boolean, boolean]>(),
    publish: jest.fn<boolean, [string, string, Buffer, Options.Publish]>(),
  };
}

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
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  async function handle(payload: object, message = buildMessage()) {
    await controller.notifyEmail(
      payload as NotifyEmailDto,
      buildContext(channel, message),
    );
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

    it('counts attempts from the main queue rejection, not from index 0 of x-death', async () => {
      const message = buildMessage(0, {}, [
        { queue: 'some.other.queue', reason: 'expired', count: 1 },
        { queue: NOTIFICATIONS_QUEUE, reason: 'rejected', count: 4 },
      ]);

      await handle(VALID_PAYLOAD, message);

      expect(channel.publish).toHaveBeenCalledTimes(1);
      expect(getDlqPublishOptions().headers).toHaveProperty('x-attempts', 5);
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

    it('stores validation errors as the failure reason', async () => {
      await handle({ email: 'not-an-email', text: 'hi' });

      expect(getDlqPublishOptions().headers).toHaveProperty(
        'x-failure-reason',
        'email must be an email',
      );
    });
  });
});
