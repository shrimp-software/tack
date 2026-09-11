# Evidence rubric

Prepare packets with `python evals/grafana/score-comparison.py <run-directory>`.
Packets omit target labels and replace wrapper names, preserving actual queries and
responses. This is an aid to assessment, not a claim that the assessor cannot infer
the wrapper from its behavior. The scorer requires explicit evidence audits; it
never treats keyword presence as proof or generates model-based scores.

Every criterion gets 0 (absent/incorrect), 1 (partial), or 2 (correct and supported
by the report and captured tool evidence). The maximum is 20, or 22 for reels.
Quality assessment requires explicit evidence review; aggregation and measured performance are deterministic.
The overhaul audit was performed by the implementing assistant, not an independent
human reviewer or a separate automated grader model.

| Criterion | Evidence for full credit |
| --- | --- |
| clock | Uses fixed dataset now 2026-09-09 18:00 UTC |
| scope | Correct affected region and services, or correctly rejects the healthy-outage hypothesis |
| timeline | Identifies incident/high-load interval using aligned observations |
| quantification | Numerical business/dependency changes with units and corresponding query windows |
| controls | Healthy regional and temporal comparisons aligned to the tested hypothesis |
| logs | Scoped relevant logs corroborate observations; sampled counts are not request error ratios |
| change | Correct change/mitigation correlation; healthy case does not invent an incident/deployment |
| recovery | Correct current/recovered status supported by after-period measurements |
| calibration | Separates observations, causal inference, incomplete upstream pages and illustrative traces |
| next_actions | Focused verification/remediation proportionate to observed evidence |
| trace_provenance (reels only) | Follows a returned log trace ID and labels sampled/illustrative spans honestly |

Fixture truth: feed degradation is US East on September 9, 15:30–16:25 UTC,
ranking v2.18.0/cache namespace/Redis pressure, then rollback/warming and recovery.
Upload processing degradation is EU West on September 8, 23:00 through September 9,
01:00 UTC, HEVC/GPU memory pressure in transcoder v3.8.1, then v3.8.0 pinning and
capacity expansion. Messaging degradation is AP Southeast on September 8,
11:00–12:00 UTC, Kafka broker disk pressure and delayed acknowledgements, followed
by disk expansion/partition reassignment. Reels buffering begins September 9,
17:25 UTC in AP Southeast after edge-route-884 and is still ongoing at dataset now.
Search's periodic CPU load is not a seeded customer-impact incident.

Cross-check precise numeric claims against the captured query output and the
fixture query functions; time-window averages need not equal plateau samples.
Record each unsupported claim and factual accuracy error separately. Count actual
guidance/schema failures from tool responses; distinguish accepted downstream
query-language limitations from wrapper contract failures. Report both where present.

`audits.json` maps blind packet IDs to `scores`, `evidenceNotes`, `unsupportedClaims`,
`accuracyErrors`, and integer `guidanceSchemaFailures`. Keep specific evidence notes
so another reviewer can reproduce or challenge the assessment. An unaudited run
never receives an assumed quality score. Keep setup failures and incomplete runs.
