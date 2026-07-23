import type { HumanXInteractionApprovalRequest } from './types.js';

export function canonicalHumanXInteractionApproval(
  request: HumanXInteractionApprovalRequest,
  operatorId: string,
): string {
  switch (request.kind) {
    case 'reply':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetPostId: request.targetPostId,
        text: request.text,
        inboundOrMentionAttested: request.inboundOrMentionAttested,
        operatorId,
      });
    case 'dm_reply':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        conversationId: request.conversationId,
        inboundMessageId: request.inboundMessageId,
        text: request.text,
        recipientInitiated: request.recipientInitiated,
        operatorId,
      });
    case 'like':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetPostId: request.targetPostId,
        operatorId,
      });
    case 'follow':
    case 'unfollow':
      return JSON.stringify({
        kind: request.kind,
        operationId: request.operationId,
        approvalId: request.approvalId,
        approvedAt: request.approvedAt,
        targetUserId: request.targetUserId,
        operatorId,
      });
  }
}
