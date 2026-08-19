-- The top level of the location tree was called `lab`. It is a stored value,
-- so renaming it in the code alone would leave every existing row unreadable
-- by the enum that validates it. SQLite has no enum type, so the fix is one
-- UPDATE — and it is idempotent: a database that has never seen `lab` is
-- untouched.
UPDATE locations SET level = 'site' WHERE level = 'lab';
