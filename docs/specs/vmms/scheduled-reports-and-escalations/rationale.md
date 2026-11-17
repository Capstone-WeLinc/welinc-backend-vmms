# Rationale

The BRD and RTM require scheduled fleet summaries and role-based maintenance escalation, but the current VMMS implementation only has on-demand reports and an overdue status job. The project owner selected 7:00 AM Manila time and in-app delivery to Admin and Operations. For the day-seven Critical requirement, the owner chose a separate escalation alert so the operational work-order state machine remains unchanged.

SMS delivery is intentionally deferred because its provider, recipients, and behavior have not been decided. No SMS configuration, phone caching, or external SMS API call is included. No auth, portal, gateway, or API contract changes are part of this work.
