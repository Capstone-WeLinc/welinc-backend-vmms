# Mechanic assignments and notifications

Run `npx.cmd prisma migrate deploy` and `npx.cmd prisma generate`, then restart the API. The migrations link legacy in-house assignments and inspectors to a user only when exactly one active VMMS account with the required role matches the name. Review schedules with a null `assigned_mechanic_id`; Operations must reassign missing or ambiguous accounts. New create/update requests can send `assignedMechanicId` alongside the display name. Outsourced assignments have no mobile recipient.

Restart the analytics API too. Set its `VMMS_API_BASE_URL` to the main API URL (default `http://localhost:3000`). Analytics now requires a bearer token: fleet endpoints are restricted to Admin/Operations, and mechanics/chief mechanics can request details only for their assigned schedule. Any web analytics client must include its existing login bearer token.

The backend checks active schedules every minute, persists one notification per schedule/user/event, and the mobile app refreshes its inbox every 30 seconds while active and on return to the foreground. The inbox supports unread badges, read acknowledgements, manual refresh and connection errors. This is an in-app inbox, not an OS push-notification integration. Notifications are stored on the server and fetched when online.

Events:
- Created/assigned: emitted for active assigned schedules, including existing schedules on the first scan and newly generated recurring schedules.
- Odometer buffer: current vehicle odometer reaches reference + interval - buffer, before the target.
- Due: odometer reaches the target, or the time interval has elapsed from the start reference date.
- Overdue: odometer exceeds the target or the due calendar day has passed in Asia/Manila.
- Explicit DUE/OVERDUE statuses are also honored. Completed, cancelled and deleted schedules are excluded. Missing odometer readings do not produce mileage events. In-progress schedules do not receive new due reminders.

Notifications remain in the in-app inbox. External SMS delivery is not part of this integration.

The notification records for this feature are recreated as part of the shared services migration; no production user data is being migrated.
