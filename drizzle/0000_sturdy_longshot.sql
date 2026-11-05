CREATE TABLE `analyses` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`article_id` bigint unsigned NOT NULL,
	`relevant` boolean NOT NULL DEFAULT false,
	`summary` text,
	`implications` text,
	`tickers` json,
	`themes` json,
	`impact` enum('bullish','bearish','neutral'),
	`model` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analyses_id` PRIMARY KEY(`id`),
	CONSTRAINT `analyses_article_unq` UNIQUE(`article_id`)
);
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`external_id` varchar(512) NOT NULL,
	`url` varchar(1024),
	`title` text,
	`body` text,
	`author` varchar(255),
	`published_at` timestamp,
	`fetched_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `articles_id` PRIMARY KEY(`id`),
	CONSTRAINT `articles_source_external_unq` UNIQUE(`source_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `digests` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`date` date NOT NULL,
	`markdown` text NOT NULL,
	`meta` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `digests_id` PRIMARY KEY(`id`),
	CONSTRAINT `digests_date_unq` UNIQUE(`date`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`provider` varchar(32) NOT NULL,
	`fetch_type` varchar(16) NOT NULL,
	`identifier` varchar(512) NOT NULL,
	`label` varchar(255),
	`enabled` boolean NOT NULL DEFAULT true,
	`config` json,
	`session_status` varchar(16),
	`last_fetched_at` timestamp,
	`last_error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `analyses` ADD CONSTRAINT `analyses_article_id_articles_id_fk` FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `articles` ADD CONSTRAINT `articles_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `analyses_relevant_idx` ON `analyses` (`relevant`);--> statement-breakpoint
CREATE INDEX `articles_published_idx` ON `articles` (`published_at`);--> statement-breakpoint
CREATE INDEX `sources_provider_idx` ON `sources` (`provider`);--> statement-breakpoint
CREATE INDEX `sources_enabled_idx` ON `sources` (`enabled`);