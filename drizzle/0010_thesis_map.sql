CREATE TABLE `threads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(16),
	`name` varchar(255) NOT NULL,
	`thesis` varchar(512),
	`context` text,
	`archived` boolean NOT NULL DEFAULT false,
	`sort` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `threads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `signals` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`article_id` bigint unsigned NOT NULL,
	`thread_id` bigint unsigned,
	`candidate` varchar(255),
	`verdict` varchar(16) NOT NULL,
	`tier` varchar(16) NOT NULL,
	`note` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `signals_id` PRIMARY KEY(`id`),
	CONSTRAINT `signals_article_thread_unq` UNIQUE(`article_id`,`thread_id`)
);
--> statement-breakpoint
CREATE INDEX `signals_thread_idx` ON `signals` (`thread_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `signals` ADD CONSTRAINT `signals_thread_id_threads_id_fk` FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON DELETE cascade ON UPDATE no action;
