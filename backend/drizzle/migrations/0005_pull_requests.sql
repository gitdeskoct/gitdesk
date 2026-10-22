CREATE TABLE `pull_request_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`actor_account_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`event_type` text NOT NULL,
	`event_payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_activity_pull` ON `pull_request_activity` (`pull_request_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `pull_request_comment_anchors` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`comparison_version` integer NOT NULL,
	`source_oid` text NOT NULL,
	`target_oid` text NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`old_line` integer,
	`new_line` integer,
	`context_hash` text NOT NULL,
	`is_outdated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `pull_request_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pull_request_comment_anchors_side" CHECK(side in ('old', 'new'))
);
--> statement-breakpoint
CREATE TABLE `pull_request_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`author_account_id` text NOT NULL,
	`parent_comment_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`resolved_at` integer,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_comments_pull` ON `pull_request_comments` (`pull_request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pull_request_merge_results` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`merge_commit_oid` text NOT NULL,
	`target_oid` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pull_request_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`reviewer_account_id` text NOT NULL,
	`decision` text NOT NULL,
	`body` text NOT NULL,
	`source_oid` text NOT NULL,
	`target_oid` text NOT NULL,
	`comparison_version` integer NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pull_request_reviews_decision" CHECK(decision in ('approved', 'changes_requested', 'commented'))
);
--> statement-breakpoint
CREATE INDEX `pull_request_reviews_pull` ON `pull_request_reviews` (`pull_request_id`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `pull_request_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text NOT NULL,
	`version` integer NOT NULL,
	`source_oid` text NOT NULL,
	`target_oid` text NOT NULL,
	`merge_base_oid` text,
	`mergeability` text DEFAULT 'unknown' NOT NULL,
	`reason` text,
	`conflicts` text DEFAULT '[]' NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_request_snapshots_version` ON `pull_request_snapshots` (`pull_request_id`,`version`);--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`author_account_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`source_ref` text NOT NULL,
	`target_ref` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	`merged_at` integer,
	`merge_commit_oid` text,
	`latest_source_oid` text,
	`latest_target_oid` text,
	`comparison_version` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pull_requests_status" CHECK(status in ('open', 'closed', 'merged'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repository_number` ON `pull_requests` (`repository_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repository_idempotency` ON `pull_requests` (`repository_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `pull_requests_repository_status_updated` ON `pull_requests` (`repository_id`,`status`,`updated_at`,`id`);