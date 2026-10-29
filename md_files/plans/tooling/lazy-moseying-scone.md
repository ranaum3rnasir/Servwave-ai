# Plan: Notebook Cleanup — Remove Redundancies & Fix Shadowing

## Context
The notebook has accumulated redundant cells from iterative exploration. The user wants High + Medium priority cleanup: delete clearly duplicate/useless cells and fix the variable shadowing bug.

## File
`C:\Users\ranro\Desktop\Personal\US - Pace - Studies\Courses\SPRING 2026\Practical Data Science\Project EDA.ipynb`

## Changes

### 1. DELETE — Duplicate `df.info()` (cells `e15054fa`, `f80e8a8b`)
Both are exact repeats of the earlier `df.info()` at `a8646b80`. The next meaningful `df.info()` is `8990a5aa` (after dropping columns). These two add nothing.

### 2. DELETE — Redundant `df.isnull().sum()` (cell `918058e2`)
`isnull()` is a pandas alias for `isna()`. Cell `6d6f076d` already does `df.isna().sum()` with identical output. Remove the duplicate.

### 3. DELETE — Blank space check (cell `84f7aef9`)
`blanks=df==" "` checks for space characters across integers and datetimes. Returns all zeros. Meaningless check — safe to remove.

### 4. RENAME — Variable shadowing of `daily_sales`
- Cell `e4m0uml6nlv` (SARMIA): `daily_sales = df.groupby('DAY')['Total Amount'].sum()` → rename to `day_of_month_sales`
- Cell `orkv9fws8d` (data prep): `daily_sales = df.groupby('Date')['Total Amount'].sum()` → keep as-is
- These are fundamentally different aggregations (day-of-month 1–31 vs. calendar dates). The current shadowing means running cells out of order could silently break the holiday uptrend analysis.

## Verification
- Run all cells top-to-bottom after changes
- Confirm no `NameError` from removed cells or renamed variable
- Confirm SARMIA chart still renders (now using `day_of_month_sales`)
- Confirm holiday uptrend analysis still works (still using `daily_sales`)
