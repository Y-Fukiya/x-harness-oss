import { Hono } from 'hono';
import {
  createStaffMember,
  getStaffMembers,
  getStaffMemberById,
  updateStaffMember,
  deleteStaffMember,
} from '@x-harness/db';
import type { DbStaffMember } from '@x-harness/db';
import { requireRole } from '../middleware/auth.js';
import type { Env } from '../index.js';
import { isStrongRuntimeSecret } from '../security/session.js';

const staff = new Hono<Env>();

function serialize(row: DbStaffMember) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `xh_${hex}`;
}

// GET /api/staff — List all staff (admin only)
staff.get('/api/staff', async (c) => {
  const forbidden = requireRole(c, 'admin');
  if (forbidden) return forbidden;

  try {
    const members = await getStaffMembers(c.env.DB);
    return c.json({ success: true, data: members.map(serialize) });
  } catch (err) {
    console.error('GET /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/me — Get current staff profile (any authenticated role)
staff.get('/api/staff/me', async (c) => {
  const staffId = c.get('staffId');
  const staffRole = c.get('staffRole');
  const staffName = c.get('staffName');

  // staffId is undefined when authenticated via env API_KEY
  if (!staffId) {
    return c.json({
      success: true,
      data: {
        id: 'env',
        name: 'Env Admin',
        role: staffRole ?? 'admin',
        isActive: true,
        lastLoginAt: null,
        createdAt: null,
        updatedAt: null,
      },
    });
  }

  try {
    const member = await getStaffMemberById(c.env.DB, staffId);
    if (!member) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(member) });
  } catch (err) {
    console.error('GET /api/staff/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff — Create staff member (admin only)
staff.post('/api/staff', async (c) => {
  const forbidden = requireRole(c, 'admin');
  if (forbidden) return forbidden;

  try {
    const { name, role } = await c.req.json<{
      name: string;
      role: 'admin' | 'editor' | 'viewer';
    }>();

    if (!name || !role) {
      return c.json({ success: false, error: 'Missing required fields: name, role' }, 400);
    }

    if (!['admin', 'editor', 'viewer'].includes(role)) {
      return c.json({ success: false, error: 'Invalid role. Must be admin, editor, or viewer' }, 400);
    }

    const apiKey = generateApiKey();
    if (!isStrongRuntimeSecret(c.env.STAFF_KEY_PEPPER)) {
      return c.json({ success: false, error: 'Staff authentication is not configured' }, 503);
    }
    const member = await createStaffMember(
      c.env.DB,
      { name, role, apiKey },
      c.env.STAFF_KEY_PEPPER,
      {
      actor: 'human',
      action: 'staff.created',
      entityType: 'staff',
      entityId: '',
      before: {},
      after: { role, active: true },
      correlationId: c.req.header('X-Correlation-Id') ?? crypto.randomUUID(),
      },
    );
    return c.json({ success: true, data: { ...serialize(member), plainApiKey: apiKey } }, 201);
  } catch (err) {
    console.error('POST /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/staff/:id — Update staff member (admin only)
staff.put('/api/staff/:id', async (c) => {
  const forbidden = requireRole(c, 'admin');
  if (forbidden) return forbidden;

  try {
    const id = c.req.param('id');
    if (c.get('staffId') === id) {
      return c.json({ success: false, error: 'Cannot change the current operator account' }, 409);
    }
    const body = await c.req.json<{
      name?: string;
      role?: 'admin' | 'editor' | 'viewer';
      isActive?: boolean;
    }>();

    if (body.role !== undefined && !['admin', 'editor', 'viewer'].includes(body.role)) {
      return c.json({ success: false, error: 'Invalid role. Must be admin, editor, or viewer' }, 400);
    }
    const existing = await getStaffMemberById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (
      existing.role === 'admin'
      && (body.role !== undefined && body.role !== 'admin' || body.isActive === false)
    ) {
      const activeAdmins = await c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM staff_members WHERE role = 'admin' AND is_active = 1",
      ).first<{ count: number }>();
      if ((activeAdmins?.count ?? 0) <= 1) {
        return c.json({ success: false, error: 'Cannot disable the last active admin' }, 409);
      }
    }

    const member = await updateStaffMember(c.env.DB, id, body, {
      actor: 'human',
      action: 'staff.updated',
      entityType: 'staff',
      entityId: id,
      before: { role: existing.role, active: existing.is_active === 1 },
      after: {
        role: body.role ?? existing.role,
        active: body.isActive ?? existing.is_active === 1,
      },
      correlationId: c.req.header('X-Correlation-Id') ?? crypto.randomUUID(),
    });
    if (!member) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: serialize(member) });
  } catch (err) {
    console.error('PUT /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — Delete staff member (admin only)
staff.delete('/api/staff/:id', async (c) => {
  const forbidden = requireRole(c, 'admin');
  if (forbidden) return forbidden;

  try {
    const id = c.req.param('id');
    if (c.get('staffId') === id) {
      return c.json({ success: false, error: 'Cannot delete the current operator account' }, 409);
    }
    const existing = await getStaffMemberById(c.env.DB, id);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    if (existing.role === 'admin' && existing.is_active === 1) {
      const activeAdmins = await c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM staff_members WHERE role = 'admin' AND is_active = 1",
      ).first<{ count: number }>();
      if ((activeAdmins?.count ?? 0) <= 1) {
        return c.json({ success: false, error: 'Cannot delete the last active admin' }, 409);
      }
    }
    await deleteStaffMember(c.env.DB, id, {
      actor: 'human',
      action: 'staff.deleted',
      entityType: 'staff',
      entityId: id,
      before: {},
      after: {},
      correlationId: c.req.header('X-Correlation-Id') ?? crypto.randomUUID(),
    });
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };
