# raw pre-triage fixture — MUST never become corpus records

This directory is named after a real raw pre-triage dir (story AC4b). Its table
is deliberately BACKFILL-COMPATIBLE (id + finding + class columns, valid
disposition codes): if the directory-name fence ever stops firing, EA1/EA2
would land in the corpus as false agreement-with-claude records and the test
asserting their absence fails.

| id | sev | finding | class |
|----|-----|---------|-------|
| EA1 | HIGH | would-be false record from a raw pre-triage dir | PATCH |
| EA2 | LOW | second would-be false record | X |
