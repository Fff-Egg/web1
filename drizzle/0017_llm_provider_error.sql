ALTER TABLE `llm_usage`
  ADD COLUMN `error_category` varchar(32) NULL,
  ADD COLUMN `error_param` varchar(64) NULL;
