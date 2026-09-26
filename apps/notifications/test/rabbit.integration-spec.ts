import { Test } from '@nestjs/testing';
import { INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import amqp, { Channel, ChannelModel, GetMessage } from 'amqplib';
import {
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_QUEUE_OPTIONS,
  NOTIFICATIONS_RETRY_QUEUE,
} from '@app/common';
import { NotificationsController } from '../src/notifications.controller';
import { NotificationsService } from '../src/notifications.service';
import { setupRabbit } from '../src/rabbit-topology';

const RETRY_DELAY_MS = 200;
const MAX_ATTEMPTS = 5;
const VALID_PAYLOAD = { email: 'user@example.com', text: 'Payment received' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Notifications over RabbitMQ (integration)', () => {
  let container: StartedRabbitMQContainer;
  let app: INestMicroservice;
  let connection: ChannelModel;
  let channel: Channel;
  const notifyEmail = jest.fn();

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4-management').start();
    const url = container.getAmqpUrl();
    await setupRabbit(url, RETRY_DELAY_MS);

    app = await startNotificationsMicroservice(url);
    connection = await amqp.connect(url);
    channel = await connection.createChannel();
  }, 120_000);

  afterAll(async () => {
    await channel?.close();
    await connection?.close();
    await app?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    notifyEmail.mockReset().mockResolvedValue(undefined);
    for (const queue of [
      NOTIFICATIONS_QUEUE,
      NOTIFICATIONS_RETRY_QUEUE,
      NOTIFICATIONS_DLQ,
    ]) {
      await channel.purgeQueue(queue);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  async function startNotificationsMicroservice(url: string) {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: { notifyEmail } }],
    }).compile();

    const microservice = moduleRef.createNestMicroservice({
      transport: Transport.RMQ,
      options: {
        urls: [url],
        queue: NOTIFICATIONS_QUEUE,
        queueOptions: NOTIFICATIONS_QUEUE_OPTIONS,
        noAck: false,
        prefetchCount: 10,
      },
      logger: false,
    });
    await microservice.listen();
    return microservice;
  }

  function publishNotifyEmail(data: object) {
    const packet = { pattern: 'notify_email', data };
    channel.sendToQueue(
      NOTIFICATIONS_QUEUE,
      Buffer.from(JSON.stringify(packet)),
    );
  }

  async function waitForDlqMessage(): Promise<GetMessage> {
    return waitFor(
      async () =>
        (await channel.get(NOTIFICATIONS_DLQ, { noAck: true })) || undefined,
    );
  }

  async function waitForCalls(count: number) {
    await waitFor(() => notifyEmail.mock.calls.length >= count || undefined);
  }

  async function getMessageCount(queue: string) {
    return (await channel.checkQueue(queue)).messageCount;
  }

  async function expectAllQueuesEmpty() {
    expect(await getMessageCount(NOTIFICATIONS_QUEUE)).toBe(0);
    expect(await getMessageCount(NOTIFICATIONS_RETRY_QUEUE)).toBe(0);
    expect(await getMessageCount(NOTIFICATIONS_DLQ)).toBe(0);
  }

  it('delivers a valid message once and leaves no messages behind', async () => {
    publishNotifyEmail(VALID_PAYLOAD);

    await waitForCalls(1);
    await sleep(RETRY_DELAY_MS * 2);

    expect(notifyEmail).toHaveBeenCalledTimes(1);
    expect(notifyEmail).toHaveBeenCalledWith(
      expect.objectContaining(VALID_PAYLOAD),
    );
    await expectAllQueuesEmpty();
  });

  it('retries through the retry queue and succeeds on the next attempt', async () => {
    notifyEmail.mockRejectedValueOnce(new Error('SMTP down'));

    publishNotifyEmail(VALID_PAYLOAD);

    await waitForCalls(2);
    await sleep(RETRY_DELAY_MS * 2);

    expect(notifyEmail).toHaveBeenCalledTimes(2);
    await expectAllQueuesEmpty();
  });

  it('moves the message to the DLQ after the max number of attempts', async () => {
    notifyEmail.mockRejectedValue(new Error('SMTP down'));

    publishNotifyEmail(VALID_PAYLOAD);
    const dlqMessage = await waitForDlqMessage();

    expect(notifyEmail).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(dlqMessage.properties.headers).toMatchObject({
      'x-attempts': MAX_ATTEMPTS,
      'x-failure-reason': 'SMTP down',
    });
    const packet = JSON.parse(dlqMessage.content.toString()) as {
      data: unknown;
    };
    expect(packet.data).toEqual(VALID_PAYLOAD);
  });

  it('stops retrying once the message is in the DLQ', async () => {
    notifyEmail.mockRejectedValue(new Error('SMTP down'));

    publishNotifyEmail(VALID_PAYLOAD);
    await waitForDlqMessage();
    await sleep(RETRY_DELAY_MS * 3);

    expect(notifyEmail).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    await expectAllQueuesEmpty();
  });

  it('sends an invalid payload straight to the DLQ without retries', async () => {
    publishNotifyEmail({ email: 'not-an-email', text: 'hi' });

    const dlqMessage = await waitForDlqMessage();

    expect(notifyEmail).not.toHaveBeenCalled();
    expect(dlqMessage.properties.headers?.['x-attempts']).toBe(1);
    expect(dlqMessage.properties.headers?.['x-failure-reason']).toContain(
      'email',
    );
    await expectAllQueuesEmpty();
  });
});
