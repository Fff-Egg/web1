ALTER TABLE `analyses` ADD `needs_source_review` boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE INDEX `analyses_source_review_idx` ON `analyses` (`needs_source_review`);--> statement-breakpoint
UPDATE `analyses` a
INNER JOIN `articles` ar ON ar.`id` = a.`article_id`
INNER JOIN `sources` s ON s.`id` = ar.`source_id`
SET a.`relevant` = true,
    a.`low_priority` = true,
    a.`needs_source_review` = true,
    a.`summary` = CONCAT('[원문 확인 필요] 수집된 내용이 짧거나 비어 있습니다. 원문을 직접 확인해 주세요. ', COALESCE(ar.`title`, ''))
WHERE s.`provider` = 'x'
  AND (ar.`body` IS NULL OR CHAR_LENGTH(TRIM(ar.`body`)) <= 32);
