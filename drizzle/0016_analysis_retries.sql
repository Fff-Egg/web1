CREATE TABLE `analysis_retries` (
  `article_id` bigint unsigned NOT NULL,
  `config_key` varchar(64) NOT NULL,
  `content_key` varchar(64) NOT NULL,
  `attempts` int unsigned NOT NULL DEFAULT 0,
  `reason` varchar(32) NOT NULL,
  `held` boolean NOT NULL DEFAULT false,
  `next_retry_at` timestamp(3) NULL,
  `filter_corrected` boolean NOT NULL DEFAULT false,
  `updated_at` timestamp(3) NOT NULL,
  PRIMARY KEY (`article_id`),
  KEY `analysis_retries_next_idx` (`held`, `next_retry_at`),
  CONSTRAINT `analysis_retries_article_fk` FOREIGN KEY (`article_id`) REFERENCES `articles` (`id`) ON DELETE CASCADE
);
