-- Hand-edited after drizzle-kit: D1 needs defer_foreign_keys instead of foreign_keys=OFF, and the copy skips the new idempotency_key column.
CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`repository_id` text,
	`repository_name` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_account_created` ON `activity` (`account_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_repository` ON `activity` (`repository_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_account_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`idempotency_key` text,
	FOREIGN KEY (`owner_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "repositories_visibility" CHECK(visibility in ('private'))
);
--> statement-breakpoint
INSERT INTO `__new_repositories`("id", "owner_account_id", "name", "name_key", "description", "visibility", "default_branch", "created_at", "updated_at") SELECT "id", "owner_account_id", "name", "name_key", "description", "visibility", "default_branch", "created_at", "updated_at" FROM `repositories`;--> statement-breakpoint
DROP TABLE `repositories`;--> statement-breakpoint
ALTER TABLE `__new_repositories` RENAME TO `repositories`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name` ON `repositories` (`owner_account_id`,`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_idempotency` ON `repositories` (`owner_account_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `repositories_owner_updated` ON `repositories` (`owner_account_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `repositories_owner_name_key` ON `repositories` (`owner_account_id`,`name_key`,`id`);