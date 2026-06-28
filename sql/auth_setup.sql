-- ============================================================================
-- Anti-Corruption GM Monitor — SQL Setup
-- Run against your AzerothCore auth database (e.g., acore_auth)
-- ============================================================================

-- 1. Ensure the MySQL event scheduler is enabled (required for auto-cleanup)
SET GLOBAL event_scheduler = ON;

-- 2. Create the log table
CREATE TABLE IF NOT EXISTS `custom_gm_action_logs` (
    `id`             INT           NOT NULL AUTO_INCREMENT,
    `account_id`     INT           NOT NULL,
    `character_name` VARCHAR(12)   NOT NULL,
    `command_text`   VARCHAR(255)  NOT NULL,
    `execution_time` TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_execution_time` (`execution_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- 3. Create a daily cleanup event (deletes records older than 30 days)
CREATE EVENT IF NOT EXISTS `cleanup_old_gm_logs`
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
ON COMPLETION PRESERVE
ENABLE
DO
    DELETE FROM `custom_gm_action_logs`
    WHERE `execution_time` < NOW() - INTERVAL 30 DAY;
