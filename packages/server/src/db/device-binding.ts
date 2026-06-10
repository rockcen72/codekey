import type postgres from 'postgres';

export class DeviceBoundToOtherUser extends Error {
  statusCode = 403;
  constructor(message?: string) { super(message ?? 'device bound to another user'); }
}

// postgres.js TransactionSql extends Sql, but TypeScript sees them as
// distinct types. Accept either so callers can pass tx from sql.begin().
type DbLike = postgres.Sql<{}> | postgres.TransactionSql<{}>;

/**
 * 在事务内原子替换用户的旧设备绑定为新设备。
 * 必须在外层 sql.begin 中调用。
 *
 * 事务内顺序：
 *  0. SELECT ... FOR UPDATE 锁 user 行（per-user 串行化，防并发）
 *  1. 锁用户所有 active binding
 *  2. 校验新 device_id 不属于其他用户（或属于同一用户已解绑可恢复）
 *  3. 软解绑所有旧设备（SET unbound_at = now()）
 *  4. 绑定/恢复新设备（SET unbound_at = NULL, bound_at = now()）
 *  5. 撤销旧设备 token
 *
 * 注意：不发送 WS 通知（事务内不能依赖网络）。
 */
export async function replaceActiveDeviceBinding(
  tx: DbLike,
  userId: number,
  deviceId: string,
): Promise<{ replaced: string[] }> {
  // Step 0: 锁 user 行，串行化同一用户的并发 claim
  // 当用户无 active binding 时，Step 1 的 FOR UPDATE 锁空集不阻塞，
  // 两个事务能同时进入后续流程，导致 partial unique index 冲突或
  // 归属检查遗漏。锁 user 行确保同一时间只有一个事务处理该用户的绑定。
  await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;

  // Step 1: 锁用户所有 active binding
  const activeBindings = await tx<{ device_id: string }[]>`
    SELECT device_id FROM device_bindings
    WHERE user_id = ${userId} AND unbound_at IS NULL
    FOR UPDATE
  `;

  // Step 2: 校验新设备不属于其他用户
  const [existingBinding] = await tx<{ user_id: number | null; unbound_at: Date | null }[]>`
    SELECT user_id, unbound_at FROM device_bindings
    WHERE device_id = ${deviceId}
    FOR UPDATE
  `;
  if (existingBinding && Number(existingBinding.user_id) !== userId) {
    throw new DeviceBoundToOtherUser();
  }

  // Step 3: 软解绑旧设备
  const oldDeviceIds = activeBindings
    .map((b) => b.device_id)
    .filter((id) => id !== deviceId);

  for (const oldId of oldDeviceIds) {
    await tx`
      UPDATE device_bindings SET unbound_at = now()
      WHERE device_id = ${oldId} AND unbound_at IS NULL
    `;
  }

  // Step 4: 绑定/恢复新设备
  if (existingBinding) {
    if (existingBinding.unbound_at) {
      // 同用户重新配对：清除 unbound_at
      await tx`
        UPDATE device_bindings SET unbound_at = NULL, bound_at = now()
        WHERE device_id = ${deviceId} AND user_id = ${userId}
      `;
    }
  }
  // 无 existingBinding：由调用方在外层 INSERT

  // Step 5: 撤销旧设备 token
  if (oldDeviceIds.length > 0) {
    await tx`
      UPDATE device_tokens SET revoked = true
      WHERE device_id = ANY(${tx.array(oldDeviceIds)}::uuid[])
    `;
  }

  return { replaced: oldDeviceIds };
}
