CREATE TABLE `sync_events` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`old_oid` text,
	`new_oid` text NOT NULL,
	`result` text NOT NULL,
	`tip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_events_kind" CHECK("sync_events"."kind" IN ('push')),
	CONSTRAINT "sync_events_result" CHECK("sync_events"."result" IN ('confirmed', 'unverified'))
);
--> statement-breakpoint
CREATE INDEX `sync_events_repository` ON `sync_events` (`repository_id`,`created_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `sync_events_account` ON `sync_events` (`account_id`,`created_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `sync_events_time` ON `sync_events` (`created_at`);