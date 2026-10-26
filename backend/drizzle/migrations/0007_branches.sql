-- Hand-edited after drizzle-kit: D1 needs defer_foreign_keys instead of foreign_keys=OFF, and the
-- branch index starts from the pushes already recorded. Nothing references sync_events, so its rebuild cascades nowhere.
CREATE TABLE `repository_branches` (
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`oid` text,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_branches_name` ON `repository_branches` (`repository_id`,`name`);--> statement-breakpoint
CREATE INDEX `repository_branches_recent` ON `repository_branches` (`repository_id`,`deleted_at`,`updated_at`);--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_sync_events` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`old_oid` text,
	`new_oid` text,
	`result` text NOT NULL,
	`tip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_events_kind" CHECK("__new_sync_events"."kind" IN ('push', 'delete')),
	CONSTRAINT "sync_events_result" CHECK("__new_sync_events"."result" IN ('confirmed', 'unverified')),
	CONSTRAINT "sync_events_new_oid" CHECK("__new_sync_events"."new_oid" IS NOT NULL OR "__new_sync_events"."kind" = 'delete')
);
--> statement-breakpoint
INSERT INTO `__new_sync_events`("operation_id", "repository_id", "account_id", "kind", "ref", "old_oid", "new_oid", "result", "tip", "created_at") SELECT "operation_id", "repository_id", "account_id", "kind", "ref", "old_oid", "new_oid", "result", "tip", "created_at" FROM `sync_events`;--> statement-breakpoint
DROP TABLE `sync_events`;--> statement-breakpoint
ALTER TABLE `__new_sync_events` RENAME TO `sync_events`;--> statement-breakpoint
CREATE INDEX `sync_events_repository` ON `sync_events` (`repository_id`,`created_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `sync_events_account` ON `sync_events` (`account_id`,`created_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `sync_events_time` ON `sync_events` (`created_at`);--> statement-breakpoint
INSERT INTO `repository_branches` (`repository_id`, `name`, `oid`, `updated_at`)
SELECT `repository_id`, substr(`ref`, 12), `new_oid`, max(`created_at`) FROM `sync_events`
WHERE `kind` = 'push' AND `ref` LIKE 'refs/heads/%' GROUP BY `repository_id`, `ref`;
