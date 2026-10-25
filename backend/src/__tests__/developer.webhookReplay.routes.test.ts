/**
 * Route contract tests for the developer webhook replay endpoint.
 *
 * The Zod schemas are exported from the route module so the validation
 * contract can be exercised directly (same pattern as certificate.routes).
 */
import {
  replayDeliveryParamsSchema,
} from '../routes/developer.routes';

describe('replayDeliveryParamsSchema', () => {
  const validDeliveryId = '665f1e2b3f4a5b6c7d8e9f01';

  it('accepts a well-formed webhook id and delivery id', () => {
    const result = replayDeliveryParamsSchema.safeParse({
      id: 'wh-1',
      deliveryId: validDeliveryId,
    });
    expect(result.success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = replayDeliveryParamsSchema.safeParse({
      id: '  wh-1  ',
      deliveryId: `  ${validDeliveryId}  `,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('wh-1');
      expect(result.data.deliveryId).toBe(validDeliveryId);
    }
  });

  it('accepts an uppercase ObjectId', () => {
    expect(
      replayDeliveryParamsSchema.safeParse({
        id: 'wh-1',
        deliveryId: validDeliveryId.toUpperCase(),
      }).success,
    ).toBe(true);
  });

  it('rejects an empty webhook id', () => {
    expect(
      replayDeliveryParamsSchema.safeParse({
        id: '   ',
        deliveryId: validDeliveryId,
      }).success,
    ).toBe(false);
  });

  it('rejects an over-long webhook id', () => {
    expect(
      replayDeliveryParamsSchema.safeParse({
        id: 'x'.repeat(129),
        deliveryId: validDeliveryId,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed delivery id', () => {
    expect(
      replayDeliveryParamsSchema.safeParse({
        id: 'wh-1',
        deliveryId: 'not-an-objectid',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty delivery id', () => {
    expect(
      replayDeliveryParamsSchema.safeParse({
        id: 'wh-1',
        deliveryId: '',
      }).success,
    ).toBe(false);
  });
});
