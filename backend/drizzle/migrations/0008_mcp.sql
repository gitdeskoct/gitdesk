CREATE TABLE `mcp_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`grant_key` text NOT NULL,
	`client_name` text NOT NULL,
	`tool` text NOT NULL,
	`repository_id` text,
	`outcome` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_audit_outcome" CHECK("mcp_audit"."outcome" IN ('ok', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `mcp_audit_account_created` ON `mcp_audit` (`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `mcp_audit_time` ON `mcp_audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_grant_usage` (
	`grant_key` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_grant_usage_account` ON `mcp_grant_usage` (`account_id`);--> statement-breakpoint
CREATE INDEX `mcp_grant_usage_last_used` ON `mcp_grant_usage` (`last_used_at`);