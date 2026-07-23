export interface SecurityAuditInput {
  actor: 'human' | 'hermes' | 'system' | 'codex';
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  correlationId: string;
}

export function securityAuditStatement(
  db: D1Database,
  input: SecurityAuditInput,
  timestamp = new Date().toISOString(),
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO cubelic_audit_logs
      (audit_id, actor, action, entity_type, entity_id, before_json, after_json, timestamp, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `aud_${crypto.randomUUID()}`,
    input.actor,
    input.action,
    input.entityType,
    input.entityId,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    timestamp,
    input.correlationId,
  );
}
