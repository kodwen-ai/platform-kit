import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  intersectPermissions,
  isSubset,
  levelSatisfies,
  narrowPermissions,
  permissionDiff,
  PermissionsSchema,
  permissionsToScope,
  requiresReconsent,
  scopeToPermissions,
  type Permissions,
} from './permissions';

const level = fc.constantFrom('read' as const, 'write' as const, 'admin' as const);
const slug = fc.stringMatching(/^[a-z][a-z0-9_.]{0,8}$/);
const perms: fc.Arbitrary<Permissions> = fc.dictionary(slug, level, { maxKeys: 6 });

describe('permission algebra', () => {
  it('orders levels read < write < admin', () => {
    expect(levelSatisfies('admin', 'read')).toBe(true);
    expect(levelSatisfies('write', 'write')).toBe(true);
    expect(levelSatisfies('read', 'write')).toBe(false);
  });

  it('intersection keeps common resources at the lower level', () => {
    expect(
      intersectPermissions(
        { a: 'admin', b: 'read', c: 'write' },
        { a: 'write', b: 'admin', d: 'read' },
      ),
    ).toEqual({ a: 'write', b: 'read' });
  });

  it('intersection is commutative', () => {
    fc.assert(
      fc.property(perms, perms, (a, b) => {
        expect(intersectPermissions(a, b)).toEqual(intersectPermissions(b, a));
      }),
    );
  });

  it('intersection is idempotent', () => {
    fc.assert(
      fc.property(perms, (a) => {
        expect(intersectPermissions(a, a)).toEqual(a);
      }),
    );
  });

  it('intersection is a subset of both operands', () => {
    fc.assert(
      fc.property(perms, perms, (a, b) => {
        const i = intersectPermissions(a, b);
        expect(isSubset(i, a) && isSubset(i, b)).toBe(true);
      }),
    );
  });

  it('narrowing a subset always succeeds and stays within granted', () => {
    fc.assert(
      fc.property(perms, perms, (granted, other) => {
        const requested = intersectPermissions(granted, other);
        const r = narrowPermissions(granted, requested);
        expect(r.ok).toBe(true);
        if (r.ok) expect(isSubset(r.permissions, granted)).toBe(true);
      }),
    );
  });

  it('narrowing never yields more than granted', () => {
    fc.assert(
      fc.property(perms, perms, (granted, requested) => {
        const r = narrowPermissions(granted, requested);
        if (r.ok) expect(isSubset(r.permissions, granted)).toBe(true);
        else expect(isSubset(requested, granted)).toBe(false);
      }),
    );
  });

  it('narrowing rejects over-asking and names the exceeded resources', () => {
    expect(narrowPermissions({ a: 'read' }, { a: 'write', b: 'read' })).toEqual({
      ok: false,
      exceeded: ['a', 'b'],
    });
  });

  it('narrowing without a request returns all granted', () => {
    expect(narrowPermissions({ a: 'read' })).toEqual({ ok: true, permissions: { a: 'read' } });
  });

  it('diff reports added, upgraded, downgraded and removed', () => {
    expect(
      permissionDiff({ a: 'read', b: 'admin', c: 'write' }, { a: 'write', b: 'read', d: 'read' }),
    ).toEqual({
      added: { d: 'read' },
      upgraded: { a: 'write' },
      downgraded: { b: 'read' },
      removed: ['c'],
    });
  });

  it('re-consent is needed only when adding or upgrading', () => {
    expect(requiresReconsent({ a: 'write' }, { a: 'read' })).toBe(false);
    expect(requiresReconsent({ a: 'write' }, {})).toBe(false);
    expect(requiresReconsent({ a: 'read' }, { a: 'write' })).toBe(true);
    expect(requiresReconsent({}, { b: 'read' })).toBe(true);
  });

  it('re-consent is false exactly when new ⊆ old', () => {
    fc.assert(
      fc.property(perms, perms, (a, b) => {
        expect(requiresReconsent(a, b)).toBe(!isSubset(b, a));
      }),
    );
  });

  it('scope string round-trips', () => {
    fc.assert(
      fc.property(perms, (p) => {
        expect(scopeToPermissions(permissionsToScope(p))).toEqual(p);
      }),
    );
  });

  it('malformed scope strings are rejected', () => {
    expect(scopeToPermissions('invoices')).toBeNull();
    expect(scopeToPermissions('Invoices:read')).toBeNull();
    expect(scopeToPermissions('invoices:owner')).toBeNull();
    expect(scopeToPermissions('')).toEqual({});
  });

  it('schema rejects bad slugs and levels', () => {
    expect(PermissionsSchema.safeParse({ 'invoices.read': 'write' }).success).toBe(true);
    expect(PermissionsSchema.safeParse({ '9x': 'read' }).success).toBe(false);
    expect(PermissionsSchema.safeParse({ a: 'owner' }).success).toBe(false);
  });
});
