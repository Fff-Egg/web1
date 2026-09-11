-- The former importance prompt often equated "personal interpretation" or
-- "no direct earnings/flow implication" with low value. Promote recent,
-- readable, substantively summarized posts once; future rows are protected by
-- the strict lowReason contract in analyze.ts.
UPDATE `analyses` a
INNER JOIN `articles` ar ON ar.`id` = a.`article_id`
SET a.`low_priority` = false
WHERE a.`relevant` = true
  AND a.`low_priority` = true
  AND a.`needs_source_review` = false
  AND ar.`deleted_at` IS NULL
  AND CHAR_LENGTH(TRIM(COALESCE(ar.`body`, ''))) >= 120
  AND CHAR_LENGTH(TRIM(COALESCE(a.`summary`, ''))) >= 80
  AND a.`created_at` >= NOW() - INTERVAL 3 DAY;
