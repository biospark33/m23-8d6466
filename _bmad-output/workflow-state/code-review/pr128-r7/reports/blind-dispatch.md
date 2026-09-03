# Blind Review: src-dispatch chunk

NO FINDINGS

The diff is a clean implementation of:
- Type-safe cap validation at dispatch boundary
- Promise-based single-flight serialization for the admission critical section
- Proper finally-structured release (no deadlock on throws)
- Best-effort record correlation writes (failure logged, never masks refusal)
- Correct EEXIST path discrimination (store vs driver) using resolved/basename fallback

All error paths escalate correctly; the ledger-close handler's non-throw is intentional and documented.
