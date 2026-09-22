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

SMS uses the existing Semaphore settings in the **backend** `.env`; never place the API key in the mobile app. Configure a funded `SEMAPHORE_API_KEY`, an approved `SEMAPHORE_SENDER_NAME`, and the mechanic's valid Philippine mobile number in their profile. `SEMAPHORE_DRY_RUN=true` prevents external sends and leaves notifications pending. Set it to `false` only when ready for live delivery; pending eligible events, including existing assignments, will then be sent. Initial scans can generate created, due and overdue events together.

`ACCEPTED` means Semaphore accepted the request, not that the handset received it. Delivery claims are atomic across workers. `FAILED`, `UNKNOWN`, or an interrupted `SENDING` record needs provider reconciliation before manually resetting it to `PENDING`; uncertain sends are deliberately not automatically repeated. Pending events are skipped after reassignment, deletion, cancellation or completion. Missing/invalid phone numbers remain pending until corrected.

Checks: `npx.cmd jest --runInBand maintenance-schedules` and `npx.cmd tsc --noEmit` in the backend; `npx.cmd tsc --noEmit` in mobile and analytics. Tests mock SMS and never send texts.

Provider protocol: https://semaphore.co/docs
