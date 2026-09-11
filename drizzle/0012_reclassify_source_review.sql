-- 0011 conservatively marked every short X post and every post containing an
-- attached X Article URL. That also captured substantive rumours/opinions.
-- Remove the old marker when readable tweet text follows it, then enqueue every
-- source-review row for the new deterministic classification on server boot.
UPDATE `articles`
SET `body` = TRIM(SUBSTRING(`body`, CHAR_LENGTH('[원문 본문 미수집 — 직접 확인 필요]') + 1))
WHERE `body` LIKE CONCAT('[원문 본문 미수집 — 직접 확인 필요]', '%')
  AND CHAR_LENGTH(TRIM(SUBSTRING(`body`, CHAR_LENGTH('[원문 본문 미수집 — 직접 확인 필요]') + 1))) > 0;--> statement-breakpoint
DELETE FROM `analyses` WHERE `needs_source_review` = true;
