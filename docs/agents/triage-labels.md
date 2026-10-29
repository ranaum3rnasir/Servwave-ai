# Triage Labels

Mapping of the five canonical triage roles to this repo's label strings.

| Canonical role     | Our tracker label  | Meaning                                  |
| ------------------ | ------------------ | ---------------------------------------- |
| `needs-triage`     | `needs-triage`     | Maintainer needs to evaluate this issue  |
| `needs-info`       | `needs-info`       | Waiting on reporter for more information |
| `ready-for-agent`  | `ready-for-agent`  | Fully specified, ready for an AFK agent  |
| `ready-for-human`  | `ready-for-human`  | Requires human implementation            |
| `wontfix`          | `wontfix`          | Will not be actioned                     |

When a skill mentions a role, use the corresponding label string from this table.

## Relationship to `auto-fix-eligible`

`ready-for-agent` indicates a human has reviewed the issue and decided it is appropriate for an AFK agent.

`auto-fix-eligible` is a narrower signal: the nightly fix-cron may pick this up without further review. An issue can be `ready-for-agent` but NOT `auto-fix-eligible` (e.g., the fix requires DB migration or touches payments). It should not be `auto-fix-eligible` without also being `ready-for-agent` or carrying a clear root cause + scoped fix in the body.
