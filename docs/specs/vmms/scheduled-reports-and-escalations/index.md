# Scheduled fleet reports and maintenance escalation

**Status:** Approved for implementation
**Owner:** VMMS backend

## Summary

VMMS will generate a daily fleet operations summary and a monthly maintenance and fuel cost summary at 7:00 AM Asia/Manila time. It will deliver both reports in-app to active Admin and Operations users. Overdue maintenance will generate in-app escalation alerts at one, three, and seven days, with the seven-day alert marked Critical while preserving the work-order's operational status.

## Requirements

- **FR-09.2:** Escalate overdue maintenance to Chief Mechanic at day 1, Admin and Operations at day 3, and all three roles at day 7, marking the day-7 escalation Critical.
- **FR-09.1:** Schedule-created, due, overdue, and odometer-buffer notifications are in-app for the assigned mechanic. SMS delivery and any additional recipients remain deferred until the product decision is made.
- **FR-25.1:** Automatically generate a daily summary of overdue trucks, trucks under maintenance, and fuel anomalies for Admin and Operations.
- **FR-25.2:** Automatically generate a fleet-wide maintenance and fuel cost summary on the first of each month.
- **Decision:** Reports run at 7:00 AM Asia/Manila time and are delivered in-app to Admin and Operations.
- **Decision:** Critical is an escalation alert label. It does not replace or mutate the work-order status.

## Behavior and data

- Use the VMMS PostgreSQL database as the source of current operational data.
- Persist each report with its type, period key, generated time, and JSON summary. A unique type and period key makes scheduled runs idempotent across restarts and multiple service instances.
- Use the existing per-user in-app notification channel. Report notifications contain the summary values and do not include income or profit data.
- Escalation alerts are deduplicated per user, schedule, and stage. Existing overdue status and work-order transitions remain authoritative.
- Admin and Operations can review the latest 100 saved report snapshots in the web Maintenance Reports page. Escalation notifications carry the related schedule ID so web and mobile users can open the affected work order.
- Schedule jobs use the `Asia/Manila` timezone.

## Acceptance criteria

- **AC-1:** At 7:00 AM Manila time, the daily report summarizes overdue work orders, vehicles under maintenance, and open fuel anomalies.
- **AC-2:** On the first day of each month at 7:00 AM Manila time, the monthly report sums completed maintenance costs by completion date and non-voided fuel costs by entry date for the previous calendar month.
- **AC-3:** Each report is persisted once per period and creates one in-app notification for every active, non-deleted Admin and Operations user; repeated or overlapping job execution creates no duplicate report or notification.
- **AC-4:** Overdue work orders trigger in-app alerts to Chief Mechanic at day 1, Admin and Operations at day 3, and all three roles at day 7; each stage is delivered at most once per recipient.
- **AC-5:** Day-7 alerts are visibly identified as Critical, while the work-order's existing operational status is unchanged.
- **AC-6:** User-specific notification reads remain scoped to the authenticated user's ID.
- **AC-7:** Each maintenance event creates an in-app notification for the assigned mechanic. No SMS is sent or configured until separately approved.
- **AC-8:** Admin and Operations can view saved daily and monthly report snapshots, with loading, empty, error, and refresh states.
- **AC-9:** A maintenance escalation notification opens its related work order; day-seven Critical alerts have a distinct high-contrast visual label.

## Build plan

- Persist report snapshots with unique period keys and add the Manila-time scheduled generator. Satisfies AC-1, AC-2, AC-3.
- Add idempotent role-based overdue escalation notifications and the Critical alert label. Satisfies AC-4, AC-5.
- Keep maintenance-event notification delivery in-app while SMS scope and recipient policy remain undecided. Satisfies AC-7.
- Add a role-protected report-history API and expose snapshots in the web Maintenance Reports page. Satisfies AC-8.
- Carry the schedule ID with escalation notifications, deep-link to the work order, and render the Critical stage distinctly on web and mobile. Satisfies AC-9.
- Preserve authenticated per-user notification access and existing work-order status transitions. Satisfies AC-6.

## Risks and remaining requirements

- **SMS decision pending:** FR-09.1 mentions SMS, but provider, recipient policy, and delivery behavior are undecided. Do not implement or send SMS until approved.
- Acceptance checks remain outstanding until explicitly requested and executed.
