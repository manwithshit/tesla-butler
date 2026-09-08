# Local OCR field-safety repair

## Scope

Fix deterministic extraction after Apple Vision; do not replace the OCR engine,
enable Kimi, write receipts, or change accounting rules.

- Support 实付、总费用、已充电量、充电费用、服务费用 and plain fee labels.
- Prefer explicit paid amounts over pre-discount totals.
- Numeric cells must contain a number with an optional currency/energy unit,
  not an arbitrary number inside another label. Ambiguous same-row cells are
  left unresolved; no cross-row nearest-number guessing.
- Separate fee totals from unit prices. Preserve explicit charging-end timestamps.
- Reject recognized multiple-order/list and unpaid-page markers before fallback.
  This is a conservative marker guard, not a universal screenshot classifier.
- Give actionable single-paid-receipt feedback. User confirmation is still required.

## Verification

Five new public-interface regression tests, including a failing test before each
new behavior implementation. Full suite: 267 passed, 0 failed. Syntax checks and
git diff --check passed. Initial sandbox-only failures were filesystem permission
errors in unrelated test fixture creation; authorized rerun passed.

Four existing downloaded public images were read directly by Apple Vision:

| Sample | Before | After |
| --- | --- | --- |
| A, single paid receipt | Missing amount/fees | Amount, energy, both fees match visual reference |
| D, single paid receipt | Missing amount/fees | Amount, energy, both fees match visual reference |
| B, composite vendor demo | Incorrect energy could pass validation | Explicit rejection |
| C, multi-order payment page | Amount from a different order | Explicit rejection |

Four private fixture checks remained 2 accepted / 2 rejected; no private values
were printed. Rejection is not proof that the image is unreadable. These layouts
remain outside demonstrated coverage. Real receipts file SHA-256 was unchanged.

No cloud OCR calls, messages, production restart, or GitHub push were performed.
Public screenshots and private OCR text are not included in Git.
