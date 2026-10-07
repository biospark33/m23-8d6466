# Provenance — `_bmad-output/evidence/memory/`

`2026-10-07T15-52-32-492Z-hit-rate.json` is the first real-instance baseline
(real bank, canary hit, hit-rate 0.565 over 23 probes, median 106ms), generated
by pre-round-1-patch code: its shape lacks the `origin` / `byOrigin` / `dd22`
keys added in commit `108a7e1a`. It is preserved verbatim as honest history —
current-code runs regenerate artifacts with the full shape — and the DD-22
baseline accrues live at the checkpoint.
