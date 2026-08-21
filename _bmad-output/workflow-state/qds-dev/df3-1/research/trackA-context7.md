# Track A — Context7 (done 2026-08-21)
- zod ^3.24.0 in repo: use v3 patterns (.strict(), ZodError.issues)
- .strict() rejects unknown keys; .uuid() accepts all versions — strict v4 needs regex
- 40-hex sha via .regex(/^[0-9a-f]{40}$/)
- Error path extraction: ZodError.issues[].path names offending field
- Bun.stdin.text() for ≤64KiB briefs; Bun.spawn exitCode; bun test CLI exit-code assertions
