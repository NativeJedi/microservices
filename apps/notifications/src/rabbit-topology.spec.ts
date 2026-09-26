import amqp, { Options } from 'amqplib';
import {
  NOTIFICATIONS_DLQ,
  NOTIFICATIONS_DLQ_EXCHANGE,
  NOTIFICATIONS_QUEUE,
  NOTIFICATIONS_QUEUE_OPTIONS,
  NOTIFICATIONS_RETRY_DELAY,
  NOTIFICATIONS_RETRY_EXCHANGE,
  NOTIFICATIONS_RETRY_QUEUE,
} from '@app/common';
import { setupRabbit } from './rabbit-topology';

jest.mock('amqplib');

const RABBIT_URL = 'amqp://localhost';

function buildChannel() {
  return {
    assertExchange: jest.fn(),
    assertQueue: jest.fn<Promise<unknown>, [string, Options.AssertQueue?]>(),
    bindQueue: jest.fn(),
    close: jest.fn(),
  };
}

describe('setupRabbit', () => {
  let channel: ReturnType<typeof buildChannel>;
  let connection: { createChannel: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    channel = buildChannel();
    connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
      close: jest.fn(),
    };
    jest.mocked(amqp.connect).mockResolvedValue(connection as never);
  });

  afterEach(() => jest.clearAllMocks());

  function getQueueOptions(queue: string) {
    const call = channel.assertQueue.mock.calls.find(
      ([name]) => name === queue,
    );
    return call?.[1];
  }

  it('connects to the given url', async () => {
    await setupRabbit(RABBIT_URL);

    expect(amqp.connect).toHaveBeenCalledWith(RABBIT_URL);
  });

  describe('retry path', () => {
    it('declares a durable fanout retry exchange', async () => {
      await setupRabbit(RABBIT_URL);

      expect(channel.assertExchange).toHaveBeenCalledWith(
        NOTIFICATIONS_RETRY_EXCHANGE,
        'fanout',
        { durable: true },
      );
    });

    it('delays retries and dead-letters them back to the main queue', async () => {
      await setupRabbit(RABBIT_URL);

      expect(getQueueOptions(NOTIFICATIONS_RETRY_QUEUE)).toEqual({
        durable: true,
        arguments: {
          'x-message-ttl': NOTIFICATIONS_RETRY_DELAY,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': NOTIFICATIONS_QUEUE,
        },
      });
    });

    it('uses a custom retry delay when provided', async () => {
      await setupRabbit(RABBIT_URL, 200);

      expect(
        getQueueOptions(NOTIFICATIONS_RETRY_QUEUE)?.arguments,
      ).toHaveProperty('x-message-ttl', 200);
    });

    it('binds the retry queue to the retry exchange', async () => {
      await setupRabbit(RABBIT_URL);

      expect(channel.bindQueue).toHaveBeenCalledWith(
        NOTIFICATIONS_RETRY_QUEUE,
        NOTIFICATIONS_RETRY_EXCHANGE,
        '',
      );
    });

    it('routes main queue rejections to the retry exchange', () => {
      expect(
        NOTIFICATIONS_QUEUE_OPTIONS.arguments['x-dead-letter-exchange'],
      ).toBe(NOTIFICATIONS_RETRY_EXCHANGE);
    });
  });

  describe('dead letter path', () => {
    it('declares a durable fanout DLQ exchange', async () => {
      await setupRabbit(RABBIT_URL);

      expect(channel.assertExchange).toHaveBeenCalledWith(
        NOTIFICATIONS_DLQ_EXCHANGE,
        'fanout',
        { durable: true },
      );
    });

    it('declares a durable DLQ without TTL or further dead-lettering', async () => {
      await setupRabbit(RABBIT_URL);

      expect(getQueueOptions(NOTIFICATIONS_DLQ)).toEqual({ durable: true });
    });

    it('binds the DLQ to the DLQ exchange', async () => {
      await setupRabbit(RABBIT_URL);

      expect(channel.bindQueue).toHaveBeenCalledWith(
        NOTIFICATIONS_DLQ,
        NOTIFICATIONS_DLQ_EXCHANGE,
        '',
      );
    });
  });

  it('closes the channel and connection after declaring the topology', async () => {
    await setupRabbit(RABBIT_URL);

    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('propagates connection errors', async () => {
    jest.mocked(amqp.connect).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(setupRabbit(RABBIT_URL)).rejects.toThrow('ECONNREFUSED');
  });
});
