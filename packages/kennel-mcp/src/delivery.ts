import { request } from 'node:http';

import type { ObservationEnvelope } from './observation.js';

export type KennelDeliveryConfig = {
  url: string;
  token: string;
};

export type KennelDelivery = {
  deliver(envelope: ObservationEnvelope): Promise<void>;
};

const receiverPath = '/v1/observations';
const deliveryTimeoutMs = 1_500;

function receiverUrl(config: KennelDeliveryConfig): URL {
  const url = new URL(config.url);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !isLoopback || url.pathname !== receiverPath || url.search || url.hash) {
    throw new Error(`Kennel delivery URL must be http://127.0.0.1:<port>${receiverPath} or http://[::1]:<port>${receiverPath}.`);
  }
  if (url.port.length === 0) {
    throw new Error('Kennel delivery URL must include a loopback port.');
  }
  if (config.token.length < 32 || config.token.length > 256) {
    throw new Error('KENNEL_DELIVERY_TOKEN must be between 32 and 256 characters.');
  }
  return url;
}

export function createLoopbackKennelDelivery(config: KennelDeliveryConfig): KennelDelivery {
  const url = receiverUrl(config);

  return {
    async deliver(envelope: ObservationEnvelope): Promise<void> {
      const payload = JSON.stringify(envelope);
      await new Promise<void>((resolve, reject) => {
        const pending = request(
          url,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.token}`,
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(payload),
            },
            timeout: deliveryTimeoutMs,
          },
          (response) => {
            response.resume();
            if (response.statusCode !== 202) {
              reject(new Error(`Kennel receiver returned ${response.statusCode ?? 'an unknown status'}.`));
              return;
            }
            resolve();
          },
        );
        pending.once('timeout', () => pending.destroy(new Error('Kennel receiver timed out.')));
        pending.once('error', reject);
        pending.end(payload);
      });
    },
  };
}
