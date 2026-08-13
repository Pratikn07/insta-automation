# SDD ledger — plan: docs/superpowers/plans/2026-08-11-expanded-historical-recovery-audience.md

Baseline: backend 110 files / 1702 tests (1421 passed, 281 skipped); web 33 files / 470 tests passed.

Task 1: fix round 1/5 (3 addressed, 0 open — compatibility allowed only-South-Asian blocking; malformed evidence rejected; missing-field tests added; commits 5c2b230..e21478a)
Task 1: complete (commits 6e6834d..e21478a, review clean)

Task 2: fix round 1/5 (3 addressed, 0 open — safe legacy defer fence; exported no-name classifier; standalone cap immutability test; commits 2cedebc..d71ec9d)
Task 2: complete (commits e21478a..d71ec9d, review clean; DB contract gated pending disposable PostgreSQL)

Task 3: fix round 1/5 (1 addressed, 0 open — rollout UUID canonicalized before hash and persistence; commits 0ffba3c..f32dab8)
Task 3: complete (commits d71ec9d..f32dab8, review clean; DB contracts gated pending disposable PostgreSQL)

Task 4: fix round 1/5 (2 addressed, 1 open — truthful empty output and four-call assertions fixed; distinct count still omitted zero-candidate exclusions; commits df8bbaa..c05a4c3)
Task 4: fix round 2/5 (1 addressed, 0 open — rollout exclusions union all four segment results and subtract selected people; commits c05a4c3..bc89d8c)
Task 4: complete (commits f32dab8..bc89d8c, review clean; DB contracts gated pending disposable PostgreSQL)

Task 5: fix round 1/5 (5 addressed, 1 minor open — valid state fixtures, precedence, boundary, stop-tick, campaign lock; deterministic overlap incomplete; commits b2cf7c3..1f0693b)
Task 5: fix round 2/5 (1 addressed, 0 open — PostgreSQL observes transaction-two lock wait by backend PID before release; commits 1f0693b..2ca0766)
Task 5: complete (commits bc89d8c..2ca0766, review clean; PostgreSQL race contracts gated pending disposable database)

Task 6: complete (commits 2ca0766..e96c815, review clean; PostgreSQL interleaving contracts gated pending disposable database)

Task 7: fix round 1/5 (4 addressed, 0 open — locked group identity, Express error forwarding, unknown-group failure, transactional audit; commits bc2a297..9992451)
Task 7: complete (commits e96c815..9992451, review clean; PostgreSQL cardinality/interleaving contracts gated pending disposable database)

Task 8: fix round 1/5 (5 addressed, 3 open — route/detail/error/pagination/accessibility fixed; transactional review audit, server pagination invariants, busy dialog remained; commits 8167180..749db57)
Task 8: fix round 2/5 (3 addressed, 0 open — atomic review audit, cursor/asOf enforcement, non-dismissible busy dialog; commits 749db57..f8d146c)
Task 8: complete (commits 9992451..f8d146c, review clean)

Task 9: fix round 3/5 review disposition (1 Critical + 7 Important open — cleanup totality; exact durable identity; global cleanup lock/resume; remote selector binding/adopt; atomic full-group audit; first-send source authorization; exact URL/PG identity; behavioral path coverage; commits 77260cc..7b2776e)
Task 9: fix round 4/5 implementation (8 addressed, 0 known open in focused scope — typed total cleanup and status 75; exact identity/deployment attestations; durable retry-cleanup; strict selector/adopt; atomic decision-hash-bound group transitions; exact first-send source; exact URL/PG parsing; 172 focused tests plus typecheck/shell syntax green; full parent verification pending)
