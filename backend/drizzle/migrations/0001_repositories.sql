CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_account_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name` ON `repositories` (`owner_account_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `repositories_owner_updated` ON `repositories` (`owner_account_id`,`updated_at`,`id`);