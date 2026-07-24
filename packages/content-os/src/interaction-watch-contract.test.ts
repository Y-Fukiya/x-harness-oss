import { describe, expectTypeOf, it } from 'vitest';
import type {
  InteractionCandidateId,
  InteractionOperationId,
  InteractionWatchId,
  XApprovalId,
  XInteractionWatchReadAdapter,
  XInteractionWatchPublishingAdapter,
  XOperatorId,
  XPublishingAdapter,
  XUserId,
} from './types.js';

describe('interaction watch contract', () => {
  it('keeps future watch delivery behind the publishing adapter boundary', () => {
    expectTypeOf<XInteractionWatchPublishingAdapter>()
      .toMatchTypeOf<XPublishingAdapter>();
    expectTypeOf<XInteractionWatchReadAdapter>()
      .not.toMatchTypeOf<XPublishingAdapter>();
  });

  it('uses distinct identifier types across the approval proof', () => {
    expectTypeOf<InteractionWatchId>()
      .not.toMatchTypeOf<InteractionCandidateId>();
    expectTypeOf<InteractionOperationId>()
      .not.toMatchTypeOf<XApprovalId>();
    expectTypeOf<XApprovalId>()
      .not.toMatchTypeOf<XOperatorId>();
    expectTypeOf<XOperatorId>()
      .not.toMatchTypeOf<XUserId>();
  });
});
