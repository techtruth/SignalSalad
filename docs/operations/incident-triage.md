# End User Incident Triage

1. Identify impacted room(s) and peer(s).
2. Filter diagnostics by peer/room in debug UI.
3. Confirm server pool health (ingress/egress presence and load).
4. Verify control-path milestones:
   - identity
   - room join
   - ingress/egress transport create/connect
   - producer creation
   - consumer creation
5. Classify failure:
   - client request/order issue
   - missing media callback/out-of-sequence event
   - transport close or server ejection
6. Mitigate:
   - if isolated peer: force leave/rejoin
   - if room-wide: recycle affected media server and validate re-registration
