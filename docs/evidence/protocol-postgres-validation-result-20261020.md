# Protocol PostgreSQL validation — 2026-10-20

Status: **Migration apply/postcheck PASS; protocol validation FAIL.**
Evidence is owner/server-reported, not independently observed locally.

## Validation-only migration

```text
status=passed
phase=apply-and-postcheck
preflight=passed migrationsBefore=2
migrationExitCode=0
newMigration=202610200003_protocol_native
migrationCount=3
protocolTables=8
protocolEnums=3
checkConstraints=20
partialUniqueIndexes=1
nextSeqColumns=1
```

## Single protocol test attempt

```text
status=failed
testPassed=false
cleanupVerified=false
postgresqlMajor=16
migrations=3
fixtureUsers=8
checks=6/15
failedCheck=revision-concurrent-siblings
protocol_validation_exit_code=1
timeout=not-triggered
image_id=sha256:822bfdbb939987843635e94c45d8aed8ff4029980c7988790ec2932aa94d6abf
```

The server stopped as required: no retry, cleanup, or further database inspection.
Synthetic fixtures may remain; their identifiers were omitted from the report.
The owner reports that `session_port` was not touched.

The applied validation schema closes only the migration-apply/postcheck item.
`0003` is applied only on the isolated validation database; the main database
was not touched. The failing sibling-revision case blocks protocol runtime
acceptance. The cause was a driver-only assertion bug: it expected both
responses and both heads despite the correct serialized project lock (seq2:
one head/non-conflict; seq3: two heads/conflict). The Ora8 source review is
**GO**, and the corrected driver is committed at
`c44ea02f1086c4e10b5c0ac5b190acee06fbb1b0` with offline 10/10 tests and API
typecheck PASS. It is not live validated. The original run remains **FAIL 6/15**;
product repository/migration source is unchanged, synthetic fixtures are
retained, and no retry, cleanup, or database inspection occurred. The earlier
successful two-migration project/quota run remains separate evidence.

Do not rerun the driver, reset migration state, roll back, or clean retained
fixtures automatically. Any follow-up must identify the exact fixture scope and
receive its own bounded review/authorization.
