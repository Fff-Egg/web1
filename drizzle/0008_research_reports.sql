CREATE TABLE `research_reports` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`report_date` varchar(10) NOT NULL,
	`category` varchar(24) NOT NULL,
	`title` text NOT NULL,
	`stock_name` varchar(120),
	`stock_code` varchar(16),
	`target_price` varchar(48),
	`target_price_num` bigint,
	`opinion` varchar(48),
	`broker` varchar(120),
	`pdf_url` varchar(1024),
	`source` varchar(16) NOT NULL DEFAULT 'hankyung',
	`external_id` varchar(200) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `research_reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `research_external_unq` UNIQUE(`external_id`)
);
--> statement-breakpoint
CREATE INDEX `research_date_idx` ON `research_reports` (`report_date`);
--> statement-breakpoint
CREATE INDEX `research_code_idx` ON `research_reports` (`stock_code`);
