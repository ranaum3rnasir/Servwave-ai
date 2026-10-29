# Fix: Discount value input too small

## Context
The discount value input (line 956) uses `w-10` (40px fixed width), making it nearly invisible. It should fill the remaining space in the 110px discount column after the select dropdown.

## Change
File: `frontend/src/pages/EstimateFormPage.tsx`, line 956
- `className="text-xs h-8 w-10"` → `className="text-xs h-8 flex-1 min-w-0"`
- This makes it fill remaining space in the flex container instead of being fixed at 40px
