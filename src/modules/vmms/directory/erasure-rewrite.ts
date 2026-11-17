import type { PrismaService } from '../../../shared/prisma.service';

export const ERASED_NAME = 'Deleted user';

export const ERASURE_COPY_COLUMNS = [
  {
    table: 'mechanics',
    idColumn: 'user_id',
    nameColumn: 'name',
    emailColumn: 'email',
  },
  {
    table: 'fuel_anomaly_settings',
    idColumn: 'updated_by_id',
    emailColumn: 'updated_by_email',
  },
  {
    table: 'fuel_anomaly_threshold_audits',
    idColumn: 'actor_id',
    emailColumn: 'actor_email',
  },
  {
    table: 'fuel_audit_logs',
    idColumn: 'actor_id',
    emailColumn: 'actor_email',
  },
  {
    table: 'maintenance_costing_threshold_audit',
    idColumn: 'actor_id',
    emailColumn: 'actor_email',
  },
  {
    table: 'maintenance_costing_settings',
    idColumn: 'updated_by_id',
    emailColumn: 'updated_by_email',
  },
  {
    table: 'shop_change_logs',
    idColumn: 'changed_by_user_id',
    nameColumn: 'changed_by_name',
  },
  { table: 'audit_logs', idColumn: 'user_id', emailColumn: 'email' },
  { table: 'vehicle_audit_logs', idColumn: 'user_id', emailColumn: 'email' },
  {
    table: 'maintenance_schedule_cancellations',
    idColumn: 'actor_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'maintenance_schedule_cancellations',
    idColumn: 'reviewed_by_id',
    nameColumn: 'reviewed_by_name',
    emailColumn: 'reviewed_by_email',
  },
  {
    table: 'maintenance_log_edit_unlocks',
    idColumn: 'actor_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'maintenance_log_edit_unlocks',
    idColumn: 'reviewed_by_id',
    nameColumn: 'reviewed_by_name',
    emailColumn: 'reviewed_by_email',
  },
  {
    table: 'maintenance_log_edit_audits',
    idColumn: 'actor_id',
    nameColumn: 'actor_name',
    emailColumn: 'actor_email',
  },
  {
    table: 'maintenance_schedules',
    idColumn: 'assigned_mechanic_id',
    nameColumn: 'assigned_mechanic',
  },
  {
    table: 'maintenance_schedules',
    idColumn: 'chief_mechanic_id',
    nameColumn: 'chief_mechanic',
  },
] as const;

/** Rewrite every stored copy of an erased directory identity. Names and email values remain useful
 * audit facts in a consistent erased form, while user-entered free text is left untouched. */
export async function rewriteErased(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  const erasedEmail = `deleted-${userId}@erased.invalid`;
  for (const copy of ERASURE_COPY_COLUMNS) {
    const updates: string[] = [];
    if ('nameColumn' in copy)
      updates.push(`"${copy.nameColumn}" = 'Deleted user'`);
    if ('emailColumn' in copy)
      updates.push(`"${copy.emailColumn}" = '${erasedEmail}'`);
    await prisma.$executeRawUnsafe(
      `UPDATE "${copy.table}" SET ${updates.join(', ')} WHERE "${copy.idColumn}" = $1::uuid`,
      userId,
    );
  }
}
