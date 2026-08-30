ALTER TABLE `articles` ADD `deleted_at` timestamp;--> statement-breakpoint
ALTER TABLE `digests` DROP INDEX `digests_date_unq`;--> statement-breakpoint
ALTER TABLE `digests` ADD `title` varchar(255);--> statement-breakpoint
ALTER TABLE `digests` ADD `period_start` date;--> statement-breakpoint
ALTER TABLE `digests` ADD `period_end` date;--> statement-breakpoint
ALTER TABLE `digests` ADD `deleted_at` timestamp;--> statement-breakpoint
ALTER TABLE `digests` DROP COLUMN `date`;
