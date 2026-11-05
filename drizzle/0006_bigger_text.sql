ALTER TABLE `articles` MODIFY COLUMN `body` mediumtext;--> statement-breakpoint
ALTER TABLE `analyses` MODIFY COLUMN `full_text` mediumtext;--> statement-breakpoint
ALTER TABLE `digests` MODIFY COLUMN `markdown` mediumtext NOT NULL;
