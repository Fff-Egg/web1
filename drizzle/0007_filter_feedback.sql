CREATE TABLE `filter_feedback` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`article_id` bigint unsigned,
	`signal` varchar(8) NOT NULL,
	`action` varchar(16) NOT NULL,
	`title` text,
	`summary` text,
	`source` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `filter_feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `filter_feedback_signal_idx` ON `filter_feedback` (`signal`,`created_at`);
