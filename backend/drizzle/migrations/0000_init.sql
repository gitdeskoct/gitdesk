CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`email` text NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_provider_subject` ON `auth_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `auth_identities_account` ON `auth_identities` (`account_id`);--> statement-breakpoint
CREATE TABLE `desktop_auth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`desktop_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`nonce` text NOT NULL,
	`google_code_verifier` text NOT NULL,
	`desktop_challenge` text NOT NULL,
	`desktop_state` text NOT NULL,
	`redirect_port` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_transactions_state_hash_unique` ON `oauth_transactions` (`state_hash`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`refresh_hash` text NOT NULL,
	`previous_refresh_hash` text,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_refresh_hash_unique` ON `sessions` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `sessions_account` ON `sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `sessions_previous_refresh` ON `sessions` (`previous_refresh_hash`);--> statement-breakpoint
CREATE INDEX `sessions_expires` ON `sessions` (`expires_at`);